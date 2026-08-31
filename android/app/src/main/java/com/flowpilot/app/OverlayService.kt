package com.flowpilot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.core.app.NotificationCompat

/**
 * 4. Overlay flutuante que fica POR CIMA de todo o Android (99/Uber/Maps/home).
 *
 * - Roda como FOREGROUND SERVICE: exibe uma notificação discreta e o SO não mata a
 *   janela de velocidade enquanto o motorista está em outro app.
 * - Usa TYPE_APPLICATION_OVERLAY no WindowManager para desenhar fora da WebView.
 * - Se a permissão "Exibir sobre outros apps" (ACTION_MANAGE_OVERLAY_PERMISSION) faltar
 *   nesta chamada, o serviço NÃO morre nem dá crash: apenas não infla a view e aguarda
 *   um novo start — a MainActivity (re)inicia assim que a permissão for concedida.
 */
class OverlayService : Service() {

    private var wm: WindowManager? = null
    private var raiz: View? = null
    private var proxManeuver: TextView? = null
    private var vel: TextView? = null
    private var eta: TextView? = null
    @Volatile
    private var rodando = false

    companion object {
        private const val CHANNEL_ID = "flowpilot_overlay"
        private const val NOTIF_ID = 11

        private val OVERLAY_TYPE =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
    }

    override fun onCreate() {
        super.onCreate()
        criarCanal()
        // Foreground imediato (obrigatório em O+ ao usar startForegroundService)
        iniciarForeground()
        // NÃO morre se faltar a permissão: apenas não desenha a view por enquanto.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            return
        }
        inflarOverlay()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Reinfla com segurança caso a permissão tenha sido concedida depois que o
        // serviço começou (onCreate retornou sem view) ou após o usuário revogar/conceder.
        if (raiz == null && Settings.canDrawOverlays(this)) inflarOverlay()
        return START_STICKY
    }

    private fun criarCanal() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "FlowPilot — widget flutuante",
                    NotificationManager.IMPORTANCE_MIN
                ).apply { setShowBadge(false) }
            )
        }
    }

    private fun iniciarForeground() {
        val abrir = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notificacao: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("FlowPilot")
            .setContentText("Widget de velocidade ativo — " + FlowBridge.stageTitle(this))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(abrir)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notificacao, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notificacao)
        }
    }

    private fun inflarOverlay() {
        // protege contra duplo addView (ex.: onStartCommand repetido)
        if (raiz != null) return
        wm = getSystemService(WINDOW_SERVICE) as WindowManager

        raiz = (getSystemService(LAYOUT_INFLATER_SERVICE) as LayoutInflater)
            .inflate(R.layout.overlay_flowpilot, null)

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            OVERLAY_TYPE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                    or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 16
            y = 200
        }

        vel = raiz?.findViewById(R.id.ov_vel)
        eta = raiz?.findViewById(R.id.ov_eta)
        proxManeuver = raiz?.findViewById(R.id.ov_maneuver)

        raiz?.findViewById<Button>(R.id.ov_btn_etapa)?.setOnClickListener {
            alternarEtapa()
        }
        raiz?.findViewById<Button>(R.id.ov_btn_abrir)?.setOnClickListener {
            abrirFlowPilot()
        }
        raiz?.findViewById<Button>(R.id.ov_btn_fechar)?.setOnClickListener {
            stopSelf()
        }

        runCatching { wm?.addView(raiz, params) }
        if (raiz?.parent == null) {
            // falhou (ex.: permissão revogada entre a checagem e o addView)
            raiz = null
        } else {
            atualizarCadaSegundo()
        }
    }

    /** Único toque de emergência no widget: alterna Coleta ↔ Viagem. */
    private fun alternarEtapa() {
        val proximo = if (FlowBridge.estado(this) == "embarque") "viagem" else "embarque"
        enviarParaWeb("etapa=" + proximo)
    }

    private fun enviarParaWeb(tipo: String) {
        val i = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("acaoCaptura", tipo)
        }
        startActivity(i)
    }

    private fun abrirFlowPilot() {
        val i = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(i)
    }

    private fun atualizarCadaSegundo() {
        rodando = true
        Thread {
            while (rodando) {
                try {
                    Thread.sleep(1000)
                    runOnUiThread {
                        // velocidade REAL (vinda do ForegroundLocationService via FlowBridge)
                        vel?.text = "%.0f".format(FlowBridge.velocidadeKmh(this@OverlayService))
                        // odômetro + dados da etapa na linha ETA (leitura do acumulador nativo)
                        eta?.text = FlowBridge.comporNotificacao(this@OverlayService)
                    }
                } catch (t: InterruptedException) {
                    break
                }
            }
        }.start()
    }

    private fun runOnUiThread(bloco: () -> Unit) {
        android.os.Handler(android.os.Looper.getMainLooper()).post(bloco)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        rodando = false
        raiz?.let { runCatching { wm?.removeView(it) } }
        raiz = null
        super.onDestroy()
    }
}