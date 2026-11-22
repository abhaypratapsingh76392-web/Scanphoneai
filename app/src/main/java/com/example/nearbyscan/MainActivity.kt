package com.example.nearbyscan

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.pow

class MainActivity : AppCompatActivity() {
    data class Dev(val kind: String, val id: String, val name: String, val rssi: Int?, val dist: Double?, val t: Long)

    private val devs = ConcurrentHashMap<String, Dev>()
    private lateinit var adapter: ArrayAdapter<String>
    private lateinit var status: TextView
    private lateinit var btn: Button
    private val h = Handler(Looper.getMainLooper())
    private val pool = Executors.newFixedThreadPool(32)
    private var running = false
    private var tick = 0

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 48, 24, 24) }
        status = TextView(this).apply { text = "Ready"; textSize = 14f }
        btn = Button(this).apply { text = "Start scan"; setOnClickListener { if (running) stop() else ask() } }
        adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, mutableListOf<String>())
        root.addView(btn); root.addView(status)
        root.addView(ListView(this).also { it.adapter = adapter }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    private fun perms(): Array<String> {
        val p = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 31) p += Manifest.permission.BLUETOOTH_SCAN
        if (Build.VERSION.SDK_INT >= 33) p += Manifest.permission.NEARBY_WIFI_DEVICES
        return p.toTypedArray()
    }

    private fun ask() {
        val missing = perms().filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) start() else requestPermissions(missing.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(c: Int, p: Array<out String>, r: IntArray) {
        if (r.isNotEmpty() && r.all { it == PackageManager.PERMISSION_GRANTED }) start()
        else status.text = "Permissions required (Location, Bluetooth/Nearby devices)"
    }

    private val bleCb = object : ScanCallback() {
        override fun onScanResult(type: Int, r: ScanResult) {
            val tx = r.scanRecord?.txPowerLevel ?: Int.MIN_VALUE
            val ref = if (tx != Int.MIN_VALUE && tx < 20) tx - 41 else -59
            val d = 10.0.pow((ref - r.rssi) / 25.0)
            @SuppressLint("MissingPermission")
            val n = try { r.device.name } catch (e: SecurityException) { null }
            devs["B" + r.device.address] = Dev("BLE", r.device.address, n ?: "(unnamed)", r.rssi, d, System.currentTimeMillis())
        }
    }

    private val wifiRx = object : BroadcastReceiver() {
        @SuppressLint("MissingPermission")
        override fun onReceive(c: Context, i: Intent) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            try {
                for (r in wm.scanResults) {
                    @Suppress("DEPRECATION") val ssid = r.SSID
                    val d = 10.0.pow((27.55 - 20 * log10(r.frequency.toDouble()) + abs(r.level)) / 20.0)
                    devs["W" + r.BSSID] = Dev("WiFi", r.BSSID, if (ssid.isNullOrEmpty()) "(hidden)" else ssid, r.level, d, System.currentTimeMillis())
                }
            } catch (e: SecurityException) { }
        }
    }

    @SuppressLint("MissingPermission")
    private fun start() {
        running = true; btn.text = "Stop scan"
        val bt = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (bt?.isEnabled == true) bt.bluetoothLeScanner?.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), bleCb)
        registerReceiver(wifiRx, IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION))
        loop()
    }

    @SuppressLint("MissingPermission")
    private fun stop() {
        running = false; btn.text = "Start scan"; h.removeCallbacksAndMessages(null)
        try { (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter?.bluetoothLeScanner?.stopScan(bleCb) } catch (e: Exception) { }
        try { unregisterReceiver(wifiRx) } catch (e: Exception) { }
    }

    @Suppress("DEPRECATION")
    private fun loop() {
        if (!running) return
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        if (tick % 4 == 0) wm.startScan()
        if (tick % 20 == 0) sweepLan(wm.connectionInfo?.ipAddress ?: 0)
        tick++
        val now = System.currentTimeMillis()
        devs.values.removeIf { it.kind != "LAN" && now - it.t > 30000 }
        val list = devs.values.sortedWith(compareBy({ it.dist ?: 1e9 }))
        adapter.clear()
        adapter.addAll(list.map {
            val dist = it.dist?.let { d -> "~%.1f m".format(d) } ?: "same network"
            val rs = it.rssi?.let { r -> " | $r dBm" } ?: ""
            "[${it.kind}] ${it.name}\n${it.id}$rs | $dist"
        })
        status.text = "BLE ${list.count { it.kind == "BLE" }} | WiFi ${list.count { it.kind == "WiFi" }} | LAN ${list.count { it.kind == "LAN" }}  (distance = RSSI estimate)"
        h.postDelayed({ loop() }, 1000)
    }

    private fun sweepLan(ipInt: Int) {
        if (ipInt == 0) return
        val base = "${ipInt and 0xff}.${(ipInt shr 8) and 0xff}.${(ipInt shr 16) and 0xff}."
        for (i in 1..254) pool.execute {
            try {
                val a = InetAddress.getByName(base + i)
                if (a.isReachable(500)) devs["L" + a.hostAddress] = Dev("LAN", a.hostAddress ?: "", a.canonicalHostName, null, null, System.currentTimeMillis())
            } catch (e: Exception) { }
        }
    }

    override fun onDestroy() { if (running) stop(); super.onDestroy() }
}
