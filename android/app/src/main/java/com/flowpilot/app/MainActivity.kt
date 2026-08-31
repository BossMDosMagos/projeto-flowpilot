package com.flowpilot.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.BridgeActivity
import org.json.JSONObject

/**
 * Atividade principal (Capacitor). Responsabilidades além do BridgeActivity:
 *
 * 1) Injetar `window.AndroidBridge` na WebView (status, injeção de corrida, leitura do
 *    acumulador nativo de km/óleo).
 * 2) Pedir permissão de localização (fina + fundo) e LIBERAR o Geolocation da WebView
 *    (sem isso o `navigator.geolocation` falha dentro do WebView).
 * 3) Iniciar o contador de GPS (ForegroundLocationService) assim que o app abre — assim o
 *    odômetro nunca fica "descoberto" enquanto o web ainda não carregou.
 * 4) Tratar ACTION_SEND (compartilhar da 99) e `acaoCaptura` dos serviços
 *    (`coleta=`/`destino=`/`etapa=`), injetando no JS sem recarregar.
 * 5) Modo IMERSIVO (tela cheia, barras de sistema escondidas).
 * 6) SOBER OVERLAY na ABERTURA: logo no `onCreate`/`onResume` o widget flutuante
 *    (`OverlayService`, TYPE_APPLICATION_OVERLAY) é iniciado. Se a permissão
 *    "Exibir sobre outros apps" ainda não existir, a tela nativa é aberta na hora e, ao
 *    retornar (onResume), o serviço é (re)iniciado automaticamente.
 */
class MainActivity : BridgeActivity() {

    private var ultimaVezPediuOverlay = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        entrarModoImersivo()
        injetarBridge()
        pedirPermissoes()
        // REQUISITO CRÍTICO: o contador de km precisa estar de pé o tempo todo.
        FlowActions.startServices(this, comOverlay = false)
        // GATILHO DE ABERTURA: sobe o widget flutuante já no onCreate (ou pede a permissão).
        garantirOverlay()
        tratarIntent(intent)
    }

    /** Reaplica o imersivo sempre que a janela volta a ter foco (gesto de swipe mostra as barras). */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) entrarModoImersivo()
    }

    override fun onResume() {
        super.onResume()
        // Sempre que a janela volta ao foco (inclusive após a tela de permissão de overlay),
        // garante o widget flutuante: se a permissão foi concedida, (re)inicia o serviço.
        garantirOverlay()
    }

    /**
     * Garante o widget flutuante ativo:
     *  - Sem permissão → abre a tela nativa "Exibir sobre outros apps" (uma vez até conceder).
     *  - Com permissão → inicia o OverlayService imediatamente.
     */
    private fun garantirOverlay() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            pedirPermissaoOverlay()
            return
        }
        FlowActions.startOverlay(this)
    }

    /**
     * Modo imersivo STICKY: esconde barra de status e navegação enquanto o app está aberto
     * (a UI fica 100% na tela; um swipe mostra as barras por alguns segundos e elas somem).
     * O WebView vira edge-to-edge mesmo, e o CSS usa `env(safe-area-inset-*)` (o index.html
     * já tem `viewport-fit=cover`) para respeitar o notch/câmera e a área de gestos.
     */
    private fun entrarModoImersivo() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    /** Abre a tela "Exibir sobre outros apps" (configurações) imediatamente — até conceder. */
    private fun pedirPermissaoOverlay() {
        // evita loop infinito de intents enquanto a permissão não é concedida e a janela
        // volta ao foco repetidamente sem que o usuário tenha tido tempo de agir
        val agora = System.currentTimeMillis()
        if (agora - ultimaVezPediuOverlay < 4000L) return
        ultimaVezPediuOverlay = agora
        runOnUiThread {
            try {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName")
                    )
                )
            } catch (t: Throwable) {
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        tratarIntent(intent)
    }

    private fun injetarBridge() {
        val wv = this.bridge?.webView
        wv?.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

        // libera geolocalização para o JS da WebView (mapa + transições da corrida)
        wv?.settings?.apply {
            setGeolocationEnabled(true)
            javaScriptCanOpenWindowsAutomatically = true
        }
        wv?.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback
            ) {
                callback.invoke(origin, true, false)
            }
        }
    }

    private fun pedirPermissoes() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        requestPermissions(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ),
            1001
        )
    }

    private fun tratarIntent(i: Intent?) {
        if (i == null) return

        // ACTION_SEND de qualquer app: texto compartilhado vira endereço de destino
        // (caminho manual via INTENT — o fluxo automático é o NotificationListenerService)
        if (i.action == Intent.ACTION_SEND && i.type?.startsWith("text/") == true) {
            val texto = i.getStringExtra(Intent.EXTRA_TEXT) ?: i.getStringExtra(Intent.EXTRA_SUBJECT)
            if (!texto.isNullOrBlank()) {
                abrirComQuery("destino=" + java.net.URLEncoder.encode(limparTexto(texto), "UTF-8"))
                return
            }
        }

        // acaoCaptura enviada pelos serviços (ex.: "coleta=Av. X, 10" ou
        // "viagem=1&destino=Rua Y, 20" ou "etapa=viagem")
        val cap = i.getStringExtra("acaoCaptura")
        if (!cap.isNullOrBlank()) {
            abrirComQuery(cap)
        }
    }

    /** Injeta ?coleta/&destino/&etapa sem recarregar (JS direto) quando possível. */
    private fun abrirComQuery(query: String) {
        FlowActions.startServices(this)
        // corrida chegando pelo fluxo nativo (notificação/99): garante o widget flutuante
        garantirOverlay()
        val wv = bridge?.webView ?: return
        val serverUrl = bridge?.getServerUrl().orEmpty()

        val js = construirInjecaoJS(query)
        runOnUiThread {
            try {
                if (!js.isNullOrBlank()) {
                    wv.evaluateJavascript(js, null)
                } else {
                    wv.loadUrl(serverUrl + "/?" + query)
                }
            } catch (t: Throwable) {
                wv.loadUrl(serverUrl + "/?" + query)
            }
        }
    }

    /** Traduz a query de captura numa chamada ao window.FlowPilot do app.js (seção 16). */
    private fun construirInjecaoJS(query: String): String? {
        val params = LinkedHashMap<String, String>()
        query.split('&').forEach { p ->
            if (p.contains('=')) params[p.substringBefore('=')] =
                java.net.URLDecoder.decode(p.substringAfter('=', ""), "UTF-8")
        }

        val coleta = params["coleta"]
        val destino = params["destino"]
        val viagem = params["viagem"] == "1"
        val etapa = params["etapa"]

        val esc = { s: String -> s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") }

        return when {
            coleta != null -> "FlowPilot.setEnderecoColeta(\"${esc(coleta)}\");"
            destino != null && viagem -> "FlowPilot.setDestinoFinal(\"${esc(destino)}\");"
            destino != null -> "FlowPilot.setEnderecoDestino(\"${esc(destino)}\");"
            etapa == "viagem" -> "FlowPilot.embarcou();"
            etapa == "finalizar" -> "FlowPilot.finalizar();"
            else -> null
        }
    }

    private fun limparTexto(s: String): String =
        s.replace(Regex("""[\r\n]+"""), " ").replace(Regex("""\s+"""), " ").trim()

    /** Interface exposta como `AndroidBridge` no JS (usada por app.js seção 16). */
    inner class AndroidBridge {

        /** Chamada pelo web a cada mudança de status (estado, km, óleo, rota...). */
        @JavascriptInterface
        fun onStatusChanged(json: String) {
            FlowBridge.updateStatus(this@MainActivity, json)
        }

        /** Chamado pelo web ao iniciar/terminar corrida para subir os serviços. */
        @JavascriptInterface
        fun iniciarServicos() {
            FlowActions.startServices(this@MainActivity)
            garantirOverlay()
        }

        /** Chamado pelo web ao finalizar corrida: para o overlay (notificação segue no GPS). */
        @JavascriptInterface
        fun pararOverlay() {
            stopService(Intent(this@MainActivity, OverlayService::class.java))
        }

        /**
         * Leitura do acumulador NATIVO (odômetro + Trip + óleo). É a fonte de verdade para
         * o odômetro quando o serviço de GPS está ativo; o web apenas espelha na interface.
         */
        @JavascriptInterface
        fun getStatus(): String = FlowBridge.getStatusJSON(this@MainActivity)

        /** Zera a Trip A/B no acumulador nativo (quando o motorista zera no web). */
        @JavascriptInterface
        fun resetTrip(trip: String) {
            FlowBridge.zerarTrip(this@MainActivity, trip)
        }

        /** Consulta de status agregada (para widgets/notificação do sistema). */
        @JavascriptInterface
        fun status(): String {
            val o = JSONObject()
            o.put("estado", FlowBridge.estado(this@MainActivity))
            o.put("textoNotificacao", FlowBridge.comporNotificacao(this@MainActivity))
            o.put("rotaAtiva", FlowBridge.rotaAtiva(this@MainActivity))
            o.put("kmAtual", FlowBridge.totalKm(this@MainActivity).toDouble())
            return o.toString()
        }

        /**
         * Safe area REAL do display em dp (CSS px == dp). Com o modo imersivo escondendo as
         * barras, o `env(safe-area-inset-*)` do WebView costuma vir 0 — então o nativo informa
         * o recorte do notch/câmera (topo) e a área de gestos/navegação (baixo) direto ao JS,
         * que aplica como CSS var (`--sa-top`, `--sa-bottom`) nos painéis fixos.
         */
        @JavascriptInterface
        fun getSafeArea(): String {
            var top = 0
            var bottom = 0
            try {
                val root = window.decorView.rootWindowInsets
                if (root != null) {
                    val wi = WindowInsetsCompat.toWindowInsetsCompat(root)
                    val dc = wi.displayCutout
                    if (dc != null) {
                        top = maxOf(top, dc.safeInsetTop)
                        bottom = maxOf(bottom, dc.safeInsetBottom)
                    }
                    top = maxOf(top, wi.getInsets(WindowInsetsCompat.Type.statusBars()).top)
                    bottom = maxOf(bottom, wi.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
                }
            } catch (t: Throwable) {
            }
            val d = resources.displayMetrics.density
            val o = JSONObject()
            o.put("top", top / d)
            o.put("bottom", bottom / d)
            return o.toString()
        }
    }
}