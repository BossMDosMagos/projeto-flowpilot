package com.flowpilot.app

import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import com.getcapacitor.BridgeActivity
import org.json.JSONObject

/**
 * Atividade principal (Capacitor). Três responsabilidades extras além do BridgeActivity:
 *
 * 1) Injetar `window.AndroidBridge` na WebView para:
 *    - receber o status do web (FlowPilot.buscarStatus -> enviarStatusNativo)
 *    - registrar permissões e disparar serviços quando o motorista inicia uma corrida
 * 2) Tratar ACTION_SEND (compartilhar da 99) e acaoCaptura dos serviços:
 *    injeta `?coleta=`/`?destino=`/`etapa=` no JS e na URL.
 * 3) Acessar a 99? Não: apenas polite integrar via intents.
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        injetarBridge()
        tratarIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        tratarIntent(intent)
    }

    private fun injetarBridge() {
        val view = this.bridge?.webView
        view?.addJavascriptInterface(AndroidBridge(), "AndroidBridge")
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