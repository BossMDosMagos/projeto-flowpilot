package com.flowpilot.app

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.content.Intent

/**
 * 2. Lê notificações da 99 (última corrida ativa) e injeta o endereço na WebView.
 *
 * Fluxo de negócio:
 *  - Estado "embarque": o endereço lido é tratado como COLETA.
 *  - Estado "viagem": tratado como DESTINO final.
 *  - O script web recebe via window.AndroidBridge, geocodifica (Nominatim) e traça a rota.
 *
 * ATENÇÃO: a extração do endereço é heurística. O texto real da notificação da 99 muda;
 * ajuste os regex/constantes conforme o app atual.
 */
class NotificationListenerService : NotificationListenerService() {

    private val pacotes99 = setOf(
        "com.taxis99",
        "com.taxis99.driver",
        "com.peopleapps",
        "com.ubercab.driver"
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        if (pkg !in pacotes99) return

        val extra = sbn.notification?.extras
        val titulo = extra?.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString() ?: ""
        val texto = extra?.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString() ?: ""
        val big = extra?.getCharSequence(android.app.Notification.EXTRA_BIG_TEXT)?.toString() ?: ""

        val conteudo = listOf(titulo, texto, big).joinToString(" | ")
        val endereco = extrairEndereco(conteudo) ?: return
        val estado = FlowBridge.estado(this)

        val tipo = when {
            estado == "viagem" -> "destino"
            else -> "coleta"
        }
        enviarParaWeb(tipo, endereco)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        // quando a corrida da 99 some, nada a fazer aqui
    }

    private fun extrairEndereco(texto: String): String? {
        if (texto.isBlank()) return null

        // Padrões prováveis, em ordem: "Rua X, 123", após Palavras-chave ou latas
        val regex = listOf(
            Regex("""(?:até|para o|para|de|coleta|destino)\s+([A-ZÀ-Ú][^.,|]*(?:,\s*\d{1,5})?[^.,|]*)""", RegexOption.IGNORE_CASE),
            Regex("""([A-ZÀ-Ú][A-Za-zÀ-ú0-9.º°,\s-]{8,120})""")
        )
        for (r in regex) {
            val m = r.find(texto)
            if (m != null) {
                val candidato = m.groupValues[1].trim().trimEnd()
                if (candidato.length >= 6) return candidato
            }
        }
        return null
    }

    private fun enviarParaWeb(tipo: String, endereco: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("acaoCaptura", "$tipo=$endereco")
        }
        startActivity(intent)
    }
}