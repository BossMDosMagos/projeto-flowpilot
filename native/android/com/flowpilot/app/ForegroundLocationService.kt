package com.flowpilot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * 3. GPS em segundo plano com notificação FIXA e persistente.
 * A localização real pode vir de @capacitor-community/background-geolocation ou do
 * FusedLocationProviderClient; este serviço garante o processo vivo + a notificação de status.
 */
class ForegroundLocationService : Service() {

    companion object {
        private const val CHANNEL_ID = "flowpilot_gps"
        private const val NOTIF_ID = 10
    }

    override fun onCreate() {
        super.onCreate()
        criarCanal()
        iniciarForeground()
    }

    private fun criarCanal() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val canal = NotificationChannel(
                CHANNEL_ID,
                "FlowPilot — corrida ativa",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                setShowBadge(false)
            }
            nm.createNotificationChannel(canal)
        }
    }

    private fun iniciarForeground() {
        val notificacao = montarNotificacao()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notificacao, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, notificacao)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // atualiza a notificação quando o web avisa nova posição
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, montarNotificacao())
        return START_STICKY
    }

    private fun montarNotificacao(): Notification {
        val abrir = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("FlowPilot — " + FlowBridge.stageTitle(this))
            .setContentText(FlowBridge.textoNotificacao(this))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(abrir)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        // restart defensivo (motorista esquece de fechar)
        // startForegroundService novamente aqui é opcional/nojeiro; comentado de propósito.
    }
}