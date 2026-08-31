package com.flowpilot.app

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.content.Intent

/**
 * 2. Captura 100% AUTOMÁTICA e silenciosa: lê as notificações da 99 e injeta
 *    o endereço na WebView SEM nenhum toque do motorista.
 *
 * Fases detectadas (heurística sobre título+texto da notificação):
 *  - COLETA  → notificação de nova corrida/aceite: extrai endereço e injeta
 *             `?coleta=<endereço>` (estado embarque + rota até o ponto).
 *  - VIAGEM  → notificação de "início de viagem" (slider do app): extrai
 *             destino e injeta `?viagem=1&destino=<endereço>` (estado destino
 *             final + rota).
 *
 * IMPORTANTE: os textos/pacotes da 99 mudam. Revisar as listas abaixo com a
 * versão atual do app. Pacotes históricos comuns: com.taxis99, com.peopleapps.
 */
class NotificationListenerService : NotificationListenerService() {

    private val pacotes99 = setOf(
        "com.taxis99",
        "com.taxis99.driver",
        "com.peopleapps",
        "com.ubercab.driver"
    )

    // Palavras que indicam o evento de "início de viagem" (destino na mão)
    private val pistasViagem = listOf(
        "início de viagem", "inicio de viagem", "viagem iniciada",
        "corrida iniciada", "deslize para iniciar", "deslize para começar",
        "em viagem", "viagem em andamento", "a caminho do destino",
        "destino final", "indo para", "pega do passageiro"
    )

    // Palavras que indicam nova corrida / ponto de embarque (coleta)
    private val pistasColeta = listOf(
        "nova corrida", "novo chamado", "nova solicitação", "aceitar corrida",
        "sua próxima corrida", "coleta", "retirada", "embarque", "origem",
        "local de embarque", "buscar passageiro", "ponto de embarque"
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        if (pkg !in pacotes99) return
        tratar(sbn)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        // sem ação
    }

    private fun tratar(sbn: StatusBarNotification) {
        val extra = sbn.notification?.extras ?: return
        val texto = listOf(
            extra.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString() ?: "",
            extra.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString() ?: "",
            extra.getCharSequence(android.app.Notification.EXTRA_BIG_TEXT)?.toString() ?: ""
        ).joinToString(" | ").trim()
        if (texto.isBlank()) return

        val min = texto.lowercase()
        val ehInicioViagem = pistasViagem.any { min.contains(it) }
        val ehNovaCorrida = pistasColeta.any { min.contains(it) }

        // Destino (prioridade: "início de viagem" traz o destino final)
        if (ehInicioViagem) {
            extrairEndereco(texto, destinoPrimeiro = true)?.let { end ->
                if (end.length >= 5) {
                    injetar("viagem=1&destino=" + codificar(end))
                    return
                }
            }
        }

        // Coleta / embarque
        if (ehNovaCorrida || !ehInicioViagem) {
            extrairEndereco(texto, destinoPrimeiro = false)?.let { end ->
                if (end.length >= 5) {
                    injetar("coleta=" + codificar(end))
                }
            }
        }
    }

    private fun injetar(query: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("acaoCaptura", query)
        }
        startActivity(intent)
    }

    private fun codificar(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    /**
     * Extrai o endereço do texto da notificação. quando `destinoPrimeiro`,
     * prioriza o trecho após "destino"; senão o trecho após "coleta/embarque".
     * Heurística: os apps não seguem um formato fixo — revisar com a 99 atual.
     */
    private fun extrairEndereco(texto: String, destinoPrimeiro: Boolean): String? {
        val padroes = if (destinoPrimeiro) listOf(
            Regex("""Destino\s+final?[:\s\-→]+([A-ZÀ-Ú0-9][^|•\n]*?)""", RegexOption.IGNORE_CASE),
            Regex("""Destino[:\s\-→]+([A-ZÀ-Ú0-9][^|•\n]*?)""", RegexOption.IGNORE_CASE),
            Regex("""(?:até|para o|para|indo para)[:\s]+([A-ZÀ-Ú0-9][^|•\n]*)""", RegexOption.IGNORE_CASE)
        ) else listOf(
            Regex("""Coleta[:\s\-→]+([A-ZÀ-Ú0-9][^|•\n]*?)""", RegexOption.IGNORE_CASE),
            Regex("""(?:Retirada|Embarque|Origem|Local de embarque)[:\s\-→]+([A-ZÀ-Ú0-9][^|•\n]*?)""", RegexOption.IGNORE_CASE),
            Regex("""(?:buscar|retirar)[:\s\-→]+([A-ZÀ-Ú0-9][^|•\n]*?)""", RegexOption.IGNORE_CASE)
        )

        return padroes.firstNotNullOfOrNull { r ->
            r.find(texto)?.groupValues?.getOrNull(1)?.trim()?.let { limpar(it) }
        }
    }

    private fun limpar(s: String): String {
        // encurta ruído e mantém o número (ex.: "Rua X, 123")
        var limpo = s.trim().trimEnd(',', '.', ':', '-')
        val m = Regex("""(.*?,\s*\d{1,6})""").find(limpo)
        return (m?.groupValues?.getOrNull(1) ?: limpo)
    }
}