package com.flowpilot.app

import android.app.Service
import android.content.Intent
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

/**
 * 4. Overlay flutuante que fica POR CIMA do app da 99 durante a corrida.
 * Requer permissão SYSTEM_ALERT_WINDOW.
 *
 * Conteúdo (compacto, pensado para dirigir):
 *  - velocidade (alimentado pela WebView quando o app está em 2º plano? O ideal é o mesmo
 *    ForegroundLocationService re-passar a posição; aqui lemos do FlowBridge)
 *  - botões: [Alternar Etapa] [Centralizar] [Abrir FlowPilot] [Fechar]
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
        private val OVERLAY_TYPE =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
    }

    override fun onCreate() {
        super.onCreate()
        if (!Settings.canDrawOverlays(this)) {
            stopSelf()
            return
        }
        inflarOverlay()
    }

    private fun inflarOverlay() {
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

        wm?.addView(raiz, params)
        atualizarCadaSegundo()
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