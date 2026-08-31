package com.flowpilot.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
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
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        injetarBridge()
        pedirPermissoes()
        // REQUISITO CRÍTICO: o contador de km precisa estar de pé o tempo todo.
        FlowActions.startServices(this, comOverlay = false)
        tratarIntent(intent)
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
    }
}