package com.flowpilot.app

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * Bridge compartilhada entre a WebView do app e os serviços nativos.
 *
 * REGRA DE OURO (requisito crítico): enquanto o app estiver rodando com o serviço de GPS
 * (ForegroundLocationService), o **acumulador de quilometragem é o nativo** — ele soma cada
 * distância entre ticks e persiste continuamente, mesmo com tela apagada, bloqueada ou com a
 * 99/Uber em primeiro plano. A camada web NÃO acumula quando `window.AndroidBridge` existe;
 * ela apenas lê este SharedPreferences e espelha na interface.
 */
object FlowBridge {
    private const val PREFS = "flowpilot_prefs"
    private const val KEY_ESTADO = "estado"          // livre | embarque | viagem
    private const val KEY_TEXTO_NOTIF = "texto_notificacao"
    private const val KEY_ROTA_ATIVA = "rota_ativa"
    private const val KEY_KM_ATUAL = "km_atual"      // odômetro reportado pelo web (calibração/overlay)

    // ---- Acumulador nativo (dono: ForegroundLocationService) ----
    private const val KEY_KM_SEED = "km_seed"        // odômetro do veículo (base calibrada, vinda do web)
    private const val KEY_KM_NATIVO = "km_nativo"    // distância acumulada pelo serviço
    private const val KEY_TRIP_A = "trip_a"
    private const val KEY_TRIP_B = "trip_b"
    private const val KEY_TROCA_BASE = "troca_base"  // odômetro na última troca de óleo
    private const val KEY_INTERVALO = "intervalo"
    private const val KEY_ULT_LAT = "ult_lat"
    private const val KEY_ULT_LON = "ult_lon"
    private const val KEY_ULT_TS = "ult_ts"

    private var sPrefs: SharedPreferences? = null

    fun prefs(ctx: Context): SharedPreferences {
        if (sPrefs == null) {
            sPrefs = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        }
        return sPrefs!!
    }

    fun updateStatus(ctx: Context, json: String?) {
        if (json.isNullOrBlank()) return
        try {
            val o = JSONObject(json)
            val e = prefs(ctx).edit()

            o.optString("estado", "livre").let { e.putString(KEY_ESTADO, it) }
            o.optString("textoNotificacao", "").let { e.putString(KEY_TEXTO_NOTIF, it) }
            e.putBoolean(KEY_ROTA_ATIVA, o.optBoolean("rotaAtiva", false))
            e.putFloat(KEY_KM_ATUAL, o.optDouble("kmAtual", 0.0).toFloat())

            // Intervalo de troca: sempre do web (é a fonte de configuração).
            if (o.has("intervaloTroca")) {
                e.putFloat(KEY_INTERVALO, o.optDouble("intervaloTroca", 0.0).toFloat())
            }

            // Seed do acumulador: primeira vez OU recalibração explícita do odômetro.
            val primeiroSeed = !prefs(ctx).contains(KEY_KM_SEED)
            if (primeiroSeed || o.optBoolean("recalibrarOdometro", false)) {
                val novaBase = o.optDouble("kmAtual", 0.0).toFloat()
                if (primeiroSeed) {
                    // preserva o que o serviço já acumulou antes do web carregar
                    e.putFloat(KEY_KM_SEED, novaBase)
                    if (!prefs(ctx).contains(KEY_KM_NATIVO)) e.putFloat(KEY_KM_NATIVO, 0f)
                    if (!prefs(ctx).contains(KEY_TRIP_A)) e.putFloat(KEY_TRIP_A, 0f)
                    if (!prefs(ctx).contains(KEY_TRIP_B)) e.putFloat(KEY_TRIP_B, 0f)
                } else {
                    // recalibração: preserva o "deslocamento" da troca de óleo para não
                    // voltar QUANTOS km já foram usados desde o último óleo
                    val desloc = trocaBase(ctx) - totalKm(ctx)
                    e.putFloat(KEY_KM_SEED, novaBase)
                    e.putFloat(KEY_KM_NATIVO, 0f)
                    e.putFloat(KEY_TROCA_BASE, maxOf(0f, novaBase + desloc))
                }
            }

            // Base da última troca de óleo: aceita apenas se coerente (base <= total),
            // para o web não "devolver" óleo usado com um valor atrasado.
            if (o.has("kmTrocaOleo")) {
                val base = o.optDouble("kmTrocaOleo", 0.0).toFloat()
                if (base >= 0f && base <= totalKm(ctx)) {
                    e.putFloat(KEY_TROCA_BASE, base)
                }
            }

            e.apply()
        } catch (t: Throwable) {
            // status de baixa prioridade: nunca deixar cair nada crítico
        }
    }

    fun estado(ctx: Context): String = prefs(ctx).getString(KEY_ESTADO, "livre") ?: "livre"
    fun textoNotificacao(ctx: Context): String =
        prefs(ctx).getString(KEY_TEXTO_NOTIF, "FlowPilot — LIVRE") ?: "FlowPilot — LIVRE"
    fun rotaAtiva(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_ROTA_ATIVA, false)
    fun kmAtual(ctx: Context): Float = prefs(ctx).getFloat(KEY_KM_ATUAL, 0f)

    /** Em "embarque" o motorista está indo buscar; em "viagem", rumo ao destino final. */
    fun stageTitle(ctx: Context): String = when (estado(ctx)) {
        "embarque" -> "EMBARQUE"
        "viagem" -> "EM VIAGEM"
        else -> "LIVRE"
    }

    // ---- Acumulador nativo (odômetro + trip A/B + óleo) ----

    fun seedKm(ctx: Context): Float = prefs(ctx).getFloat(KEY_KM_SEED, 0f)
    fun acumuladoKm(ctx: Context): Float = prefs(ctx).getFloat(KEY_KM_NATIVO, 0f)
    fun totalKm(ctx: Context): Float = seedKm(ctx) + acumuladoKm(ctx)
    fun tripAKm(ctx: Context): Float = prefs(ctx).getFloat(KEY_TRIP_A, 0f)
    fun tripBKm(ctx: Context): Float = prefs(ctx).getFloat(KEY_TRIP_B, 0f)
    fun trocaBase(ctx: Context): Float = prefs(ctx).getFloat(KEY_TROCA_BASE, seedKm(ctx))
    fun intervalo(ctx: Context): Float = prefs(ctx).getFloat(KEY_INTERVALO, 0f)

    /** KM que faltam para a troca; -1 quando o intervalo não está configurado. */
    fun oleoFaltaKm(ctx: Context): Float {
        val iv = intervalo(ctx)
        if (iv <= 0f) return -1f
        return maxOf(0f, iv - (totalKm(ctx) - trocaBase(ctx)))
    }

    fun somarKm(ctx: Context, km: Float) {
        val e = prefs(ctx).edit()
        e.putFloat(KEY_KM_NATIVO, acumuladoKm(ctx) + km)
        e.putFloat(KEY_TRIP_A, tripAKm(ctx) + km)
        e.putFloat(KEY_TRIP_B, tripBKm(ctx) + km)
        e.apply() // gravação contínua: simples no tempo e segura contra crash (após o in-memory)
    }

    fun zerarTrip(ctx: Context, trip: String) {
        val e = prefs(ctx).edit()
        when (trip) {
            "A" -> e.putFloat(KEY_TRIP_A, 0f)
            "B" -> e.putFloat(KEY_TRIP_B, 0f)
        }
        e.apply()
    }

    fun guardarFix(ctx: Context, lat: Double, lon: Double, ts: Long) {
        val e = prefs(ctx).edit()
        e.putFloat(KEY_ULT_LAT, lat.toFloat())
        e.putFloat(KEY_ULT_LON, lon.toFloat())
        e.putLong(KEY_ULT_TS, ts)
        e.apply()
    }

    fun ultLat(ctx: Context): Double = prefs(ctx).getFloat(KEY_ULT_LAT, 0f).toDouble()
    fun ultLon(ctx: Context): Double = prefs(ctx).getFloat(KEY_ULT_LON, 0f).toDouble()
    fun ultTs(ctx: Context): Long = prefs(ctx).getLong(KEY_ULT_TS, 0L)

    /** Status agregado de quilometragem (usado pelo web via AndroidBridge.getStatus). */
    fun getStatusJSON(ctx: Context): String = JSONObject().apply {
        put("estado", estado(ctx))
        put("odometroTotal", totalKm(ctx).toDouble())
        put("tripA", tripAKm(ctx).toDouble())
        put("tripB", tripBKm(ctx).toDouble())
        put("kmTrocaBase", trocaBase(ctx).toDouble())
        put("intervaloTroca", intervalo(ctx).toDouble())
        put("oleoFalta", oleoFaltaKm(ctx).toDouble())
        put("textoNotificacao", comporNotificacao(ctx))
    }.toString()

    /**
     * Texto da notificação fixa. Quando o acumulador nativo já recebeu a base do web,
     * o valor exibido é o do próprio serviço (mais atual em background).
     */
    fun comporNotificacao(ctx: Context): String {
        if (!prefs(ctx).contains(KEY_KM_SEED)) return textoNotificacao(ctx)
        var t = "FlowPilot — ${stageTitle(ctx)} | Odômetro: ${fmtKm(totalKm(ctx))} km"
        val falta = oleoFaltaKm(ctx)
        if (falta >= 0f) t += " | Óleo: falta ${fmtKm(falta)} km"
        return t
    }

    private fun fmtKm(v: Float): String =
        String.format(java.util.Locale("pt", "BR"), "%,.0f", v)
}

/** Botão único para ligar/desligar o overlay e os serviços de fundo. */
object FlowActions {
    fun startServices(ctx: Context) {
        try {
            ctx.startForegroundService(
                Intent(ctx, ForegroundLocationService::class.java)
            )
        } catch (t: Throwable) {
            ctx.startService(Intent(ctx, ForegroundLocationService::class.java))
        }
        try {
            ctx.startService(Intent(ctx, OverlayService::class.java))
        } catch (t: Throwable) {
        }
    }
}