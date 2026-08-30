package com.flowpilot.app

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences

/**
 * Bridge compartilhada entre a WebView do app e os serviços nativos.
 * A camada web grava/consome o JSON de status via window.FlowPilot (seção 16 do app.js);
 * aqui guardamos num SharedPreferences para os serviços lerem mesmo com o app em 2º plano.
 */
object FlowBridge {
    private const val PREFS = "flowpilot_prefs"
    private const val KEY_ESTADO = "estado"          // livre | embarque | viagem
    private const val KEY_TEXTO_NOTIF = "texto_notificacao"
    private const val KEY_ROTA_ATIVA = "rota_ativa"
    private const val KEY_KM_ATUAL = "km_atual"

    private var sPrefs: SharedPreferences? = null

    private fun prefs(ctx: Context): SharedPreferences {
        if (sPrefs == null) sPrefs = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return sPrefs!!
    }

    fun updateStatus(ctx: Context, json: String?) {
        if (json.isNullOrBlank()) return
        try {
            val o = org.json.JSONObject(json)
            val e = prefs(ctx).edit()
            o.optString("estado", "livre").let { e.putString(KEY_ESTADO, it) }
            o.optString("textoNotificacao", "").let { e.putString(KEY_TEXTO_NOTIF, it) }
            e.putBoolean(KEY_ROTA_ATIVA, o.optBoolean("rotaAtiva", false))
            e.putFloat(KEY_KM_ATUAL, o.optDouble("kmAtual", 0.0).toFloat())
            e.apply()
        } catch (t: Throwable) {
            // status de baixa prioridade: nunca deixar cair nada crítico
        }
    }

    fun estado(ctx: Context): String = prefs(ctx).getString(KEY_ESTADO, "livre") ?: "livre"
    fun textoNotificacao(ctx: Context): String = prefs(ctx).getString(KEY_TEXTO_NOTIF, "FlowPilot — LIVRE") ?: "FlowPilot — LIVRE"
    fun rotaAtiva(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_ROTA_ATIVA, false)
    fun kmAtual(ctx: Context): Float = prefs(ctx).getFloat(KEY_KM_ATUAL, 0f)

    /** Em "embarque" o motorista está indo buscar; em "viagem", rumo ao destino final. */
    fun stageTitle(ctx: Context): String = when (estado(ctx)) {
        "embarque" -> "EMBARQUE"
        "viagem" -> "EM VIAGEM"
        else -> "LIVRE"
    }
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