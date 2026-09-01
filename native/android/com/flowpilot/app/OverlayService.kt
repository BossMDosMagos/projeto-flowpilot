package com.flowpilot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.content.res.ResourcesCompat

/**
 * 4. Bolha de velocidade flutuante do FlowPilot.
 *
 * - Roda como FOREGROUND SERVICE: exibe uma notificação discreta e o SO não mata a
 *   bolha de velocidade enquanto o motorista está em outro app (99/Uber/Maps).
 * - Usa TYPE_APPLICATION_OVERLAY no WindowManager para desenhar fora da WebView.
 * - UI mínima: só a bolha circular com o número de velocidade (fonte DS-DIGIB) + "km/h".
 * - 100% ARRASTÁVEL: um OnTouchListener na raiz segue o dedo via updateViewLayout.
 * - Personalizável pelo usuário nas Configurações (cor da fonte, cor do fundo e tamanho),
 *   persistidas via FlowBridge.overlayCor/overlayFundo/overlayTamanho — aplicadas ao vivo.
 * - Se a permissão "Exibir sobre outros apps" faltar, NÃO morre nem dá crash: apenas
 *   não infla a view e aguarda um novo start (a MainActivity re-inicia ao conceder).
 */
class OverlayService : Service() {

    private var wm: WindowManager? = null
    private var raiz: View? = null
    private var ovVel: TextView? = null      // camada de frente (velocidade real, sobre o "888")
    private var mask: TextView? = null       // camada de fundo ("888", segmentos apagados)
    private var sufixo: TextView? = null     // "km/h" abaixo
    private var params: WindowManager.LayoutParams? = null
    @Volatile
    private var rodando = false
    private var corAcesa = Color.parseColor("#00FF88")

    companion object {
        private const val CHANNEL_ID = "flowpilot_overlay"
        private const val NOTIF_ID = 11

        /** Instância corrente do serviço (para a MainActivity aplicar prefs ao vivo). */
        @Volatile
        var instancia: OverlayService? = null

        private val OVERLAY_TYPE =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
    }

    override fun onCreate() {
        super.onCreate()
        instancia = this
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
        // serviço começou (onCreate retornou sem view) ou após revogar/conceder.
        if (raiz == null && Settings.canDrawOverlays(this)) inflarOverlay()
        return START_STICKY
    }

    private fun criarCanal() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "FlowPilot — bolha de velocidade",
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
            .setContentText("Bolha de velocidade ativa — " + FlowBridge.stageTitle(this))
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

        // O diâmetro é definido DIRETAMENTE no WindowManager.LayoutParams (não no
        // layoutParams da view). Assim a janela tem o tamanho do círculo e o
        // conteúdo não "colapsa" a bolha numa gota minúscula.
        val escala = FlowBridge.overlayTamanho(this).let { if (it <= 0f) 1f else it }
        val diametroPx = (92f * escala * resources.displayMetrics.density).toInt()

        params = WindowManager.LayoutParams(
            diametroPx,
            diametroPx,
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

        ovVel = raiz?.findViewById(R.id.ov_vel)
        mask = raiz?.findViewById(R.id.ov_mask)
        sufixo = raiz?.findViewById(R.id.ov_sufixo)

        // ===== ARRASTAR E SOLTAR =====
        var initialX = 0
        var initialY = 0
        var initialTouchX = 0f
        var initialTouchY = 0f
        val rArrasto = raiz
        val pArrasto = params
        val wmArrasto = wm

        raiz?.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = pArrasto!!.x
                    initialY = pArrasto!!.y
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    pArrasto!!.x = initialX + (event.rawX - initialTouchX).toInt()
                    pArrasto!!.y = initialY + (event.rawY - initialTouchY).toInt()
                    wmArrasto?.updateViewLayout(rArrasto, pArrasto)
                    true
                }
                else -> false
            }
        }

        aplicarPreferencias()

        runCatching { wm?.addView(raiz, params) }
        if (raiz?.parent == null) {
            // falhou (ex.: permissão revogada entre a checagem e o addView)
            raiz = null
        } else {
            atualizarCadaSegundo()
        }
    }

    /** Expõe a reaplicação de preferências ao vivo (chamada pela MainActivity). */
    fun aplicarPreferenciasPublico() {
        runOnUiThread { aplicarPreferencias() }
    }

    /**
     * Aplica as preferências do painel lidas do FlowBridge (cor da fonte, cor do fundo,
     * tamanho e fonte DS-DIGIB). Chamada no inflate e sempre que o usuário muda
     * nas Configurações (via MainActivity.setOverlayPrefs -> instancia.aplicarPreferencias).
     *
     * O TAMANHO é aplicado no `params` do WindowManager (que define o diâmetro real) e,
     * se a bolha já está na tela, chamamos updateViewLayout para redimensionar ao vivo.
     */
    private fun aplicarPreferencias() {
        val ra = raiz ?: return
        val contexto = this
        val p = params ?: return

        // Fonte digital DS-DIGIB (fallback p/ monospace se algo falhar)
        var tf: Typeface? = null
        try {
            tf = ResourcesCompat.getFont(contexto, R.font.ds_digib)
        } catch (t: Throwable) {
            tf = null
        }
        if (tf == null) tf = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)

        // cores (com fallback robusto de parse)
        val cor = try { Color.parseColor(FlowBridge.overlayCor(contexto)) }
            catch (t: Throwable) { Color.parseColor("#00FF88") }
        val fundo = try { Color.parseColor(FlowBridge.overlayFundo(contexto)) }
            catch (t: Throwable) { Color.parseColor("#000000") }

        // ===== TAMANHO do círculo (no params do WindowManager, em px) =====
        val escala = FlowBridge.overlayTamanho(contexto).let { if (it <= 0f) 1f else it }
        val diametroPx = (92f * escala * resources.displayMetrics.density).toInt()
        p.width = diametroPx
        p.height = diametroPx

        // ===== FUNDO da bolha =====
        // Substitui a cor de preenchimento do shape (keep a borda discreta).
        val bg = ra.background
        if (bg is android.graphics.drawable.GradientDrawable) {
            try {
                val g = bg.mutate() as android.graphics.drawable.GradientDrawable
                g.setColor(fundo)
            } catch (t: Throwable) {
                ra.background?.mutate()?.setTint(fundo)
            }
        } else {
            ra.background?.mutate()?.setTint(fundo)
        }

        // ===== NÚMERO (2 camadas: máscara "888" + valor em cima, alinhado à direita) =====
        corAcesa = cor

        val tamanhoFonte = if (FlowBridge.overlayFonte(contexto) <= 0f) 34f else FlowBridge.overlayFonte(contexto)

        // Frente (valor real): fonte 7-segment, cor verde LED, glow sutil (não borra
        // porque só existe na camada ativa — a máscara "888" não tem sombra).
        val glow = Color.argb(100, Color.red(corAcesa), Color.green(corAcesa), Color.blue(corAcesa))
        ovVel?.apply {
            setTypeface(tf)
            textSize = tamanhoFonte
            setTextColor(corAcesa)
            setShadowLayer(4f, 0f, 0f, glow)
        }

        // Fundo (máscara "888"): mesma fonte/tamanho (para alinhar exato) mas SEM sombra.
        mask?.apply {
            setTypeface(tf)
            textSize = tamanhoFonte
            setShadowLayer(0f, 0f, 0f, 0)   // sem brilho/borrão nos segmentos apagados
        }

        sufixo?.apply {
            textSize = 10f * escala
        }

        // Atualiza o valor conforme a cor atual
        atualizarValor()

        // Redimensiona a janela ao vivo se já estiver na tela
        if (ra.parent != null) {
            runCatching { wm?.updateViewLayout(ra, p) }
        }
    }

    /**
     * Atualiza a camada de frente (ov_vel) com a velocidade REAL, sempre FORMATADA
     * ALINHADA À DIREITA para coincidir com as casas da máscara "888": um valor de
     * uma casa (ex.: 0 km/h) aparece sobre o último "8"; duas casas sobre os dois
     * últimos, e assim por diante. Pra isso o texto é pad (preenchido à esquerda
     * com espaços) e a view usa gravity=end.
     */
    private fun atualizarValor() {
        val kmh = FlowBridge.velocidadeKmh(this).toInt().coerceIn(0, 999)
        ovVel?.text = kmh.toString().padStart(3, ' ')
    }

    /** Faz a bolha seguir o dedo na tela em tempo real (drag-and-drop). */
    private fun atualizarCadaSegundo() {
        rodando = true
        Thread {
            while (rodando) {
                try {
                    Thread.sleep(1000)
                    runOnUiThread {
                        // velocidade REAL (vinda do ForegroundLocationService via FlowBridge)
                        atualizarValor()
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
        instancia = null
        raiz?.let { runCatching { wm?.removeView(it) } }
        raiz = null
        super.onDestroy()
    }
}
