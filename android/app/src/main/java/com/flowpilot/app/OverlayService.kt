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
import android.media.AudioManager
import android.media.ToneGenerator
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

/**
 * 4. Painel HUD flutuante do FlowPilot.
 *
 * - Roda como FOREGROUND SERVICE: exibe uma notificação discreta e o SO não mata o
 *   painel enquanto o motorista está em outro app (99/Uber/Maps).
 * - Usa TYPE_APPLICATION_OVERLAY no WindowManager para desenhar fora da WebView.
 * - UI: HUD circular (fundo branco/cinza + borda VERMELHA) com as zonas:
 *     a) ALERTA DE ÓLEO  { * }        -> pisca quando a troca está pendente.
 *     b) ODÔMETRO TOTAL  ODO:xxxxx    -> máscara inativa ao fundo + valor.
 *     c) VELOCÍMETRO     3 dígitos    -> malha "~~~" + valor ativo em cima.
 *     d) UNIDADE         KM/H.
 *     e) ODÔMETRO PARCIAL TRIP:xxxxx  -> valor da viagem com máscara.
 * - Todo texto digital usa a fonte DSEG14Modern-Bold (assets/fonts).
 * - 100% ARRASTÁVEL: um OnTouchListener na raiz segue o dedo via updateViewLayout.
 * - ÁUDIO: beep alto (ToneGenerator, TONE_CDMA_HIGH_L) a cada 5s quando a troca de
 *   óleo está pendente E o veículo está parado (vel=0). Em movimento, silencia.
 * - Se a permissão "Exibir sobre outros apps" faltar, NÃO morre nem dá crash: apenas
 *   não infla a view e aguarda um novo start (a MainActivity re-inicia ao conceder).
 */
class OverlayService : Service() {

    private var wm: WindowManager? = null
    private var raiz: View? = null

    // Zonas do HUD
    private var ovVel: TextView? = null      // velocidade (camada ativa, sobre a malha)
    private var mask: TextView? = null       // malha "~~~" do velocímetro
    private var ovOdo: TextView? = null      // odômetro total (valor)
    private var ovOdoMask: TextView? = null  // máscara do odômetro
    private var ovTrip: TextView? = null     // odômetro parcial (valor)
    private var ovTripMask: TextView? = null // máscara do odômetro parcial
    private var ovUnit: TextView? = null     // "KM/H"
    private var ovOilAlert: TextView? = null // alerta de óleo { * }

    private var params: WindowManager.LayoutParams? = null

    @Volatile
    private var rodando = false

    /** Alterna o pisca-pisca do alerta de óleo. */
    private var alertaVisivel = false

    /** Momento (ms) do último beep de alerta de óleo. */
    private var ultimoBeepMs = 0L

    private var tone: ToneGenerator? = null

    companion object {
        private const val CHANNEL_ID = "flowpilot_overlay"
        private const val NOTIF_ID = 11
        private const val TICK_MS = 500L          // tick visual (pisca)
        private const val BEEP_MS = 5000L         // beep a cada 5 s

        /** Instância corrente do serviço (para a MainActivity aplicar prefs ao vivo). */
        @Volatile
        var instancia: OverlayService? = null

        private val OVERLAY_TYPE =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
    }

    /** Troca de óleo pendente quando o intervalo está configurado e já foi percorrido. */
    private fun trocaOleoPendente(): Boolean {
        val iv = FlowBridge.intervalo(this)
        if (iv <= 0f) return false
        return FlowBridge.oleoFaltaKm(this) <= 0f
    }

    override fun onCreate() {
        super.onCreate()
        instancia = this
        criarCanal()
        iniciarForeground()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            return
        }
        inflarOverlay()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (raiz == null && Settings.canDrawOverlays(this)) inflarOverlay()
        return START_STICKY
    }

    private fun criarCanal() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "FlowPilot — painel HUD",
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
            .setContentText("Painel HUD ativo — " + FlowBridge.stageTitle(this))
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
        if (raiz != null) return
        wm = getSystemService(WINDOW_SERVICE) as WindowManager

        raiz = (getSystemService(LAYOUT_INFLATER_SERVICE) as LayoutInflater)
            .inflate(R.layout.overlay_flowpilot, null)

        // O tamanho do HUD é definido DIRETAMENTE no WindowManager.LayoutParams.
        val escala = FlowBridge.overlayTamanho(this).let { if (it <= 0f) 1f else it }
        val ladoPx = (180f * escala * resources.displayMetrics.density).toInt()

        params = WindowManager.LayoutParams(
            ladoPx,
            ladoPx,
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
        ovOdo = raiz?.findViewById(R.id.ov_odo)
        ovOdoMask = raiz?.findViewById(R.id.ov_odo_mask)
        ovTrip = raiz?.findViewById(R.id.ov_trip)
        ovTripMask = raiz?.findViewById(R.id.ov_trip_mask)
        ovUnit = raiz?.findViewById(R.id.ov_unit)
        ovOilAlert = raiz?.findViewById(R.id.ov_oil_alert)

        setupDrag()

        aplicarPreferencias()

        runCatching { wm?.addView(raiz, params) }
        if (raiz?.parent == null) {
            raiz = null
        } else {
            iniciarLoop()
        }
    }

    /** Drag-and-drop: o painel segue o dedo na tela via updateViewLayout. */
    private fun setupDrag() {
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
                    initialX = pArrasto?.x ?: 0
                    initialY = pArrasto?.y ?: 0
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (pArrasto != null) {
                        pArrasto.x = initialX + (event.rawX - initialTouchX).toInt()
                        pArrasto.y = initialY + (event.rawY - initialTouchY).toInt()
                        wmArrasto?.updateViewLayout(rArrasto, pArrasto)
                    }
                    true
                }
                else -> false
            }
        }
    }

    /** Expõe a reaplicação de preferências ao vivo (chamada pela MainActivity). */
    fun aplicarPreferenciasPublico() {
        runOnUiThread { aplicarPreferencias() }
    }

    /**
     * Aplica a fonte DSEG14 em TODAS as zonas do HUD, os tamanhos e as cores fixas
     * do design. O tamanho do círculo vai no `params` do WindowManager.
     */
    private fun aplicarPreferencias() {
        val ra = raiz ?: return
        val contexto = this
        val p = params ?: return

        // Fonte digital DSEG14 (7-segmentos oficial) — aplicada a todas as zonas.
        var tf: Typeface? = null
        try {
            tf = Typeface.createFromAsset(contexto.assets, "fonts/DSEG14Modern-Bold.ttf")
        } catch (t: Throwable) {
            tf = null
        }
        if (tf == null) tf = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)

        // ===== TAMANHO do círculo (no params do WindowManager) =====
        val escala = FlowBridge.overlayTamanho(contexto).let { if (it <= 0f) 1f else it }
        val ladoPx = (180f * escala * resources.displayMetrics.density).toInt()
        p.width = ladoPx
        p.height = ladoPx

        // ===== FONTES e CORES de cada zona =====
        val tamanhoVel = if (FlowBridge.overlayFonte(contexto) <= 0f) 36f else FlowBridge.overlayFonte(contexto)

        // Velocímetro: camada ativa + malha "~~~" (mesma fonte/tamanho)
        ovVel?.apply {
            setTypeface(tf)
            textSize = tamanhoVel
            setTextColor(Color.parseColor("#000000"))
            setShadowLayer(0f, 0f, 0f, 0)
        }
        mask?.apply {
            setTypeface(tf)
            textSize = tamanhoVel
            text = "~~~"
            setTextColor(Color.parseColor("#25000000"))
            setShadowLayer(0f, 0f, 0f, 0)
        }

        // Odômetro total (texto contínuo "ODO:xxxxx" definido em atualizarDados)
        ovOdo?.apply { setTypeface(tf); setTextColor(Color.parseColor("#000000")) }
        ovOdoMask?.apply { setTypeface(tf); setTextColor(Color.parseColor("#25000000")) }

        // Odômetro parcial (texto contínuo "TRIP:xxx" definido em atualizarDados)
        ovTrip?.apply { setTypeface(tf); setTextColor(Color.parseColor("#000000")) }
        ovTripMask?.apply { setTypeface(tf); setTextColor(Color.parseColor("#25000000")) }

        // Unidade + alerta de óleo
        ovUnit?.apply { setTypeface(tf) }
        ovOilAlert?.apply { setTypeface(tf) }

        // Atualiza os valores
        atualizarDados()
        atualizarAlertaOleo()

        // Redimensiona a janela ao vivo se já estiver na tela
        if (ra.parent != null) {
            runCatching { wm?.updateViewLayout(ra, p) }
        }
    }

    /**
     * Atualiza ODÔMETRO TOTAL, ODÔMETRO PARCIAL e VELOCIDADE. Os valores são sempre
     * alinhados à direita (pad à esquerda com espaços) para se sobrepor às máscaras.
     */
    private fun atualizarDados() {
        val ctx = this
        // ODÔMETRO TOTAL — texto contínuo "ODO:xxxxx": máscara com ~ na mesma contagem
        val odo = FlowBridge.totalKm(ctx).toInt().toString()
        ovOdoMask?.text = "ODO:" + "~".repeat(odo.length)
        ovOdo?.text = "ODO:$odo"
        // ODÔMETRO PARCIAL — texto contínuo "TRIP:xxx": máscara com ~ na mesma contagem
        val trip = FlowBridge.tripAKm(ctx).toInt().toString()
        ovTripMask?.text = "TRIP:" + "~".repeat(trip.length)
        ovTrip?.text = "TRIP:$trip"
        // VELOCIDADE — 3 dígitos, valor alinhado à direita sobre a malha "~~~"
        val kmh = FlowBridge.velocidadeKmh(ctx).toInt().coerceIn(0, 999)
        ovVel?.text = kmh.toString().padStart(3, ' ')
    }

    /**
     * Atualiza o alerta de óleo: pisca quando a troca está pendente e gerencia o beep.
     *   - pendente E parado (vel=0): beep a cada 5 s + pisca.
     *   - pendente E em movimento (vel>0): mantém só o pisca, SEM beep.
     *   - não pendente: esconde o alerta.
     */
    private fun atualizarAlertaOleo() {
        val pendente = trocaOleoPendente()
        val vel = FlowBridge.velocidadeKmh(this)
        val agora = System.currentTimeMillis()

        if (!pendente) {
            ovOilAlert?.visibility = View.INVISIBLE
            ultimoBeepMs = agora
            return
        }

        // pisca-pisca (alterna a cada tick de 500 ms)
        alertaVisivel = !alertaVisivel
        ovOilAlert?.visibility = if (alertaVisivel) View.VISIBLE else View.INVISIBLE

        if (vel > 0f) {
            // em movimento: silencia o beep e reinicia a janela de 5 s
            ultimoBeepMs = agora
            return
        }

        // parado: beep a cada 5 s
        if (agora - ultimoBeepMs >= BEEP_MS) {
            ultimoBeepMs = agora
            emitirBeep()
        }
    }

    /** Emite o beep alto de alerta (TONE_CDMA_HIGH_L) via ToneGenerator. */
    private fun emitirBeep() {
        try {
            if (tone == null) tone = ToneGenerator(AudioManager.STREAM_ALARM, 100)
            tone?.startTone(ToneGenerator.TONE_CDMA_HIGH_L, 300)
        } catch (t: Throwable) {
            // sem áudio disponível: segue a vida
        }
    }

    private fun iniciarLoop() {
        rodando = true
        Thread {
            while (rodando) {
                try {
                    Thread.sleep(TICK_MS)
                    runOnUiThread {
                        atualizarDados()
                        atualizarAlertaOleo()
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
        runCatching { tone?.release() }
        tone = null
        raiz?.let { runCatching { wm?.removeView(it) } }
        raiz = null
        super.onDestroy()
    }
}