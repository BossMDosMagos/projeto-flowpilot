package com.flowpilot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices

/**
 * 3. GPS em segundo plano — REQUISITO CRÍTICO: odômetro e troca de óleo NÃO param.
 *
 * Garantias desta implementação:
 *  - GPS de alta precisão (LocationRequest.PRIORITY_HIGH_ACCURACY via FusedLocationProvider,
 *    com fallback para o provider GPS puro do sistema).
 *  - Serviço em primeiro plano com notificação fixa persistente (barra de status).
 *  - **Partial WakeLock**: impede o CPR do celular de entrar em deep sleep enquanto
 *    a contagem estiver ativa.
 *  - **Cada distância entre ticks é somada** ao odômetro acumulado E à da contagem de
 *    troca de óleo (base conservada), gravando o progresso continuamente via FlowBridge.
 *  - Rejeita ruído (< 0,5 m), saltos (> 200 m) e fixes imprecisos (> 40 m);
 *    filtrar velocidade derivada (d/t) < 2 km/h para não contar carro parado.
 */
class ForegroundLocationService : Service() {

    companion object {
        private const val CHANNEL_ID = "flowpilot_gps"
        private const val NOTIF_ID = 10
        private const val WAKE_TAG = "flowpilot:gps"

        private const val MIN_TICK_MS = 1000L          // intervalo de atualização da Fused
        private const val FAST_TICK_MS = 500L          // fastestInterval
        private const val GPS_MIN_TICK_MS = 1500L      // fallback: provider GPS puro
        private const val PRECISAO_MAX_M = 40f         // rejeita fix impreciso (jitter)
        private const val RUIDO_MIN_M = 0.5f           // ignora micro-deslocamentos
        private const val RUIDO_MAX_M = 200f           // ignora salto de GPS (fuso/túnel)
        private const val VEL_MIN_KMH = 2f             // veloc. mínima derivada p/ contar
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var enabledGps = false

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let { processarFix(it) }
        }
    }

    private val gpsListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) = processarFix(loc)
        @Suppress("DEPRECATION")
        override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onCreate() {
        super.onCreate()
        criarCanal()
        iniciarForeground()
        adquirirWakeLock()
        iniciarGPS()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // atalho defensivo: se o sistema matou o wake lock, re-adquire e re-registra GPS
        adquirirWakeLock()
        if (!enabledGps) iniciarGPS()
        atualizarNotificacao()
        return START_STICKY
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

    private fun adquirirWakeLock() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG).apply {
                    setReferenceCounted(false)
                }
            }
            wakeLock?.acquire()
        } catch (t: Throwable) {
            // tão crítico; sem wake lock o SO pode suspender a CPU (aí não conta)
        }
    }

    private fun iniciarGPS() {
        // 1) Preferência: FusedLocation (PRIORITY_HIGH_ACCURACY) — requer
        //    implementation "com.google.android.gms:play-services-location" no build.gradle.
        val okFused = try {
            val req = LocationRequest.create()
                .setPriority(LocationRequest.PRIORITY_HIGH_ACCURACY)
                .setInterval(MIN_TICK_MS)
                .setFastestInterval(FAST_TICK_MS)
                .setSmallestDisplacement(0f)
            LocationServices.getFusedLocationProviderClient(this)
                .requestLocationUpdates(req, locationCallback, Looper.getMainLooper())
            true
        } catch (t: Throwable) {
            false
        }
        if (okFused) {
            enabledGps = true
            return
        }

        // 2) Fallback: provider GPS puro do sistema (mesma precisão, sem Play Services).
        enabledGps = try {
            val lm = getSystemService(LOCATION_SERVICE) as LocationManager
            lm.requestLocationUpdates(
                LocationManager.GPS_PROVIDER, GPS_MIN_TICK_MS, 0f,
                gpsListener, Looper.getMainLooper()
            )
            true
        } catch (t: Throwable) {
            false
        }
    }

    /** Entra aqui a cada tick do GPS: soma a distância ao odômetro + óleo e persiste. */
    private fun processarFix(loc: Location) {
        val lat0 = FlowBridge.ultLat(this)
        val lon0 = FlowBridge.ultLon(this)
        val ts0 = FlowBridge.ultTs(this)
        FlowBridge.guardarFix(this, loc.latitude, loc.longitude, System.currentTimeMillis())

        // primeiro fix: apenas vira referência
        if (lat0 == 0.0 && lon0 == 0.0 || ts0 <= 0L) return

        // rejeita fix impreciso (ruído parado / túnel)
        if (loc.accuracy <= 0f || loc.accuracy > PRECISAO_MAX_M) return

        val a = Location("").apply { latitude = lat0; longitude = lon0 }
        val d = a.distanceTo(loc)
        if (d.let { it.isNaN() || it <= RUIDO_MIN_M || it >= RUIDO_MAX_M }) return

        // velocidade DERIVADA (d/t) — independe do provider entregar speed
        val dtS = (System.currentTimeMillis() - ts0) / 1000f
        if (dtS <= 0.1f) return
        val kmh = (d / dtS) * 3.6f
        if (kmh < VEL_MIN_KMH) return

        // soma direto no acumulador nativo (odômetro + Trip A/B) e grava continuamente
        FlowBridge.somarKm(this, d / 1000f)
        atualizarNotificacao()
    }

    private fun atualizarNotificacao() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, montarNotificacao())
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
            .setContentText(FlowBridge.comporNotificacao(this))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(abrir)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        // NÃO parar: o serviço precisa continuar contando km (sem onDestroy)
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            val lm = getSystemService(LOCATION_SERVICE) as LocationManager
            lm.removeUpdates(gpsListener)
        } catch (t: Throwable) {
        }
        try {
            LocationServices.getFusedLocationProviderClient(this)
                .removeLocationUpdates(locationCallback)
        } catch (t: Throwable) {
        }
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            wakeLock = null
        } catch (t: Throwable) {
        }
    }
}