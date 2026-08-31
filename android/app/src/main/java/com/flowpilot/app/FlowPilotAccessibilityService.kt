package com.flowpilot.app

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Intent
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * 5. Captura de endereços da 99 / Uber por ACESSIBILIDADE.
 *
 * Complementa o NotificationListenerService: quando o app de corrida está em PRIMEIRO PLANO
 * (a notificação nem sempre chega / a 99 não usa notificação para o aceite), este serviço
 * lê a árvore de nós de texto (`AccessibilityNodeInfo`) da tela e deteta:
 *
 *  - COLETA  → tela de corrida aceita ("Nova corrida", "Ponto de embarque", "Coleta: ...")
 *             → injeta `?coleta=<endereço>` (estado embarque + rota).
 *  - VIAGEM  → tela de início de viagem ("Deslize para iniciar", "Em viagem", "Destino")
 *             → injeta `?viagem=1&destino=<endereço>`.
 *
 * O endereço é repassado ao frontend JS pelo mesmo caminho do NotificationListenerService:
 * Intent `acaoCaptura` → MainActivity → `evaluateJavascript` → {@code FlowPilot.setEndereco*}
 * (isto É "ir direto pro AndroidBridge": MainActivity é quem mantém o `addJavascriptInterface`).
 *
 * IMPORTANTE: os textos/pacotes da 99/Uber mudam — revisar com as versões atuais.
 * Pacotes históricos: com.taxis99, com.taxis99.driver, com.peopleapps, com.ubercab.driver.
 */
class FlowPilotAccessibilityService : AccessibilityService() {

    private val pacotesAlvo = setOf(
        "com.taxis99",
        "com.taxis99.driver",
        "com.peopleapps",
        "com.ubercab.driver",
        "com.ubercab"
    )

    // Palavras fortes de "início de viagem" (prioridade sobre coleta)
    private val pistasViagem = listOf(
        "início de viagem", "inicio de viagem", "viagem iniciada",
        "corrida iniciada", "deslize para iniciar", "deslize para começar",
        "iniciar viagem", "em viagem", "viagem em andamento", "a caminho do destino",
        "destino final", "indo para", "chegada ao destino", "destino"
    )

    // Palavras de nova corrida / ponto de embarque (coleta)
    private val pistasColeta = listOf(
        "nova corrida", "novo chamado", "nova solicitação", "aceitar corrida",
        "corrida aceita", "aceite a corrida", "coleta", "retirada", "embarque",
        "origem", "ponto de embarque", "local de embarque", "buscar passageiro",
        "pegar passageiro", "ir para o passageiro", "passageiro esperando"
    )

    private val TAG = "FlowPilot_Accessibility"

    /** Deduplica: mesma (pacote, fase, endereço) não é reinjetada dentro da janela. */
    private var ultimaChave = ""
    private var ultimoTempo = 0L
    private val WINDOW_DEDUPE_MS = 30_000L

    override fun onServiceConnected() {
        super.onServiceConnected()
        val info = serviceInfo
        Log.d(TAG, "Serviço de acessibilidade CONECTADO.")
        info?.let {
            Log.d(TAG, "Pacotes configurados: " + (it.packageNames?.joinToString(", ") ?: "*"))
            Log.d(TAG, "Eventos: " + it.eventTypes)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg !in pacotesAlvo) return

        val tipoNome = when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> "WINDOW_STATE_CHANGED"
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> "WINDOW_CONTENT_CHANGED"
            AccessibilityEvent.TYPE_VIEW_CLICKED -> "VIEW_CLICKED"
            AccessibilityEvent.TYPE_VIEW_SCROLLED -> "VIEW_SCROLLED"
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> "VIEW_TEXT_CHANGED"
            else -> return
        }
        Log.d(TAG, "Evento [$tipoNome] pkg=$pkg class=${event.className}")

        val raiz = rootInActiveWindow ?: run {
            Log.d(TAG, "rootInActiveWindow nulo — ignorando evento $tipoNome de $pkg")
            return
        }

        val linhas = coletarTextos(raiz)
        Log.d(TAG, "Textos na tela ($pkg): ${linhas.size}")
        if (linhas.isEmpty()) return

        val min = linhas.joinToString(" | ").lowercase()
        val forteViagem = pistasViagem.any { min.contains(it) }
        val forteColeta = pistasColeta.any { min.contains(it) }
        Log.d(TAG, "Heurística → viagem=$forteViagem coleta=$forteColeta")

        val fase: String = when {
            forteViagem -> "viagem"
            forteColeta -> "coleta"
            else -> {
                Log.d(TAG, "Nenhum quadro de corrida detectado na tela atual — nada a fazer.")
                return
            }
        }

        val endereco = extrairEndereco(linhas, fase)
        if (endereco == null || endereco.length < 5) {
            Log.d(TAG, "Endereço não reconhecido (fase=$fase). Textos=$linhas")
            return
        }

        // Dedupe por pacote+fase+endereço dentro de 30s
        val chave = "$pkg|$fase|$endereco"
        val agora = System.currentTimeMillis()
        if (chave == ultimaChave && agora - ultimoTempo < WINDOW_DEDUPE_MS) {
            Log.d(TAG, "Deduplicado (mesma captura recente): $endereco")
            return
        }
        ultimaChave = chave
        ultimoTempo = agora

        Log.d(TAG, ">>> CORRIDA DETECTADA em $pkg (fase=$fase) endereço='$endereco'")
        val query = if (fase == "viagem") "viagem=1&destino=" else "coleta="
        injetarNaWeb(query + java.net.URLEncoder.encode(endereco, "UTF-8").replace("+", "%20"))
    }

    /**
     * Percorre a árvore de nós de texto em pós-ordem, coletando as strings visíveis.
     * Protege contra ciclos e nós já reciclados pelo sistema.
     */
    @SuppressLint("UnsafeOptInUsageError")
    private fun coletarTextos(raiz: AccessibilityNodeInfo?): List<String> {
        val resultado = ArrayList<String>()
        val visitados = HashSet<Int>()

        fun caminhar(no: AccessibilityNodeInfo?) {
            if (no == null) return
            try {
                val id = System.identityHashCode(no)
                if (!visitados.add(id)) return
                val txt = no.text?.toString()?.trim()
                if (!txt.isNullOrBlank() && txt.length > 1) resultado.add(txt)
                for (i in 0 until no.childCount) {
                    caminhar(no.getChild(i))
                }
            } catch (t: Throwable) {
                // nó reciclado/inválido — segue o baile
            } finally {
                // não recicla nós do rootInActiveWindow aqui (o sistema gerencia o ciclo)
            }
        }
        caminhar(raiz)
        return resultado
    }

    /**
     * Extrai o endereço da tela. 1) tenta os padrões com rótulo (mesma heurística do
     * NotificationListenerService); 2) senão, a primeira linha que "parece endereço"
     * (pista de tipo de via + número, ou vírgula + número).
     */
    private fun extrairEndereco(linhas: List<String>, fase: String): String? {
        val texto = linhas.joinToString(" | ")

        val padroes = if (fase == "viagem") listOf(
            Regex("""(?:Destino|Chegada|Chegou)\s*(?:final)?[:\s\-→]+([A-ZÀ-Ú0-9][^|•\n]*?)""", RegexOption.IGNORE_CASE),
            Regex("""(?:até|para o destino|para|indo para)[:\s]+([A-ZÀ-Ú0-9][^|•\n]*)""", RegexOption.IGNORE_CASE)
        ) else listOf(
            Regex("""(?:Coleta|Retirada|Embarque|Origem|Local de embarque|Ponto de embarque)[:\s\-→]+([A-ZÀ-Ú0-9][^|•\n]*?)""", RegexOption.IGNORE_CASE),
            Regex("""(?:buscar|retirar|pegar)[:\s\-→]+([A-ZÀ-Ú0-9][^|•\n]*?)""", RegexOption.IGNORE_CASE)
        )

        padroes.firstNotNullOfOrNull { r ->
            r.find(texto)?.groupValues?.getOrNull(1)?.trim()?.let { limparEndereco(it) }
        }?.let { if (it.length >= 5) return it }

        // Fallback por linha: algo com via + número (ex.: "Rua A, 123", "Av. B")
        val pistaVia = Regex("""\b(Rua|Av\.?|Avenida|Rod\.?|Rodovia|Estrada|Alameda|Travessa|Praça|Pça\.?|Beco|Viela)\.[?\s]""", RegexOption.IGNORE_CASE)
        val temNumero = Regex("""\d{1,6}""")
        for (linha in linhas) {
            val limpa = limparEndereco(linha)
            if (limpa.length < 6) continue
            val pareceEndereco =
                (pistaVia.containsMatchIn(limpa) && temNumero.containsMatchIn(limpa)) ||
                        (limpa.contains(",") && temNumero.containsMatchIn(limpa))
            if (pareceEndereco && !limpa.lowercase().contains("número")) return limpa
        }
        return null
    }

    private fun limparEndereco(s: String): String {
        var limpo = s.trim().trimEnd(',', '.', ':', '-')
        val m = Regex("""(.*?,\s*\d{1,6})""").find(limpo)
        return (m?.groupValues?.getOrNull(1) ?: limpo).trim()
    }

    /** Repassa pro JS da mesma forma que o notificador: Intent acaoCaptura → MainActivity. */
    private fun injetarNaWeb(query: String) {
        Log.d(TAG, "Enviando para a web: acaoCaptura=$query")
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("acaoCaptura", query)
        }
        startActivity(intent)
    }

    override fun onInterrupt() {
        Log.d(TAG, "Serviço interrompido pelo sistema.")
    }
}