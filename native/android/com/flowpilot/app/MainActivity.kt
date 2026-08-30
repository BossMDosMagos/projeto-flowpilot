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

        // ACTION_SEND de qualquer app: texto compartilhado vira endereço de coleta/destino
        if (i.action == Intent.ACTION_SEND && i.type?.startsWith("text/") == true) {
            val texto = i.getStringExtra(Intent.EXTRA_TEXT) ?: i.getStringExtra(Intent.EXTRA_SUBJECT)
            if (!texto.isNullOrBlank()) {
                abrirComParametros("destino", limparTexto(texto))
                return
            }
        }

        // acaoCaptura enviada pelos serviços (etapa= / coleta= / destino=)
        val cap = i.getStringExtra("acaoCaptura")
        if (!cap.isNullOrBlank()) {
            val chave = cap.substringBefore('=')
            val valor = cap.substringAfter('=', "")
            abrirComParametros(chave, valor)
        }
    }

    private fun abrirComParametros(chave: String, valor: String) {
        val url = "${bridge?.getServerUrl().orEmpty()}/?$chave=${java.net.URLEncoder.encode(valor, "UTF-8")}"
        bridge?.webView?.loadUrl(url)
        // também inicia serviços para manter GPS + notificação
        FlowActions.startServices(this)
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

        /** Consulta de status agregada (para widgets/notificação do sistema). */
        @JavascriptInterface
        fun status(): String {
            val o = JSONObject()
            o.put("estado", FlowBridge.estado(this@MainActivity))
            o.put("textoNotificacao", FlowBridge.textoNotificacao(this@MainActivity))
            o.put("rotaAtiva", FlowBridge.rotaAtiva(this@MainActivity))
            o.put("kmAtual", FlowBridge.kmAtual(this@MainActivity).toDouble())
            return o.toString()
        }
    }
}