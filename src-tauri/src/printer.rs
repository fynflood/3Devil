//! Live status from Bambu Lab printers over their local MQTT broker
//! (TLS on port 8883, user `bblp`, password = the printer's LAN access code).

use rumqttc::tokio_rustls::rustls::{
    self,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::CryptoProvider,
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use rumqttc::tokio_rustls::TlsConnector;
use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpStream;
use tokio::time::timeout;

const PORT: u16 = 8883;

/// Bambu printers present an X.509 v1 certificate from Bambu's private CA for
/// a name that isn't the IP we dial, which rustls/webpki can't verify at all
/// (it rejects v1 certificates even for the handshake signature). Without a
/// trusted chain the signature check would prove nothing, so this accepts the
/// printer's certificate as-is, as Bambu's own tools do on the LAN.
#[derive(Debug)]
struct AcceptPrinterCert(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptPrinterCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub(crate) fn tls_config() -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptPrinterCert(provider)))
        .with_no_client_auth()
}

#[derive(Serialize, Clone)]
pub struct FoundPrinter {
    pub(crate) ip: String,
    pub(crate) serial: String,
    pub(crate) model: String,
}

/// Best-effort model name from the serial-number prefix.
fn model_from_serial(serial: &str) -> String {
    let model = match serial.get(..3).unwrap_or("") {
        "00M" => "X1 Carbon",
        "00W" => "X1",
        "03W" => "X1E",
        "01P" => "P1S",
        "01S" => "P1P",
        "039" => "A1",
        "030" => "A1 mini",
        _ => "Bambu Lab printer",
    };
    model.to_string()
}

/// Connects to the printer's TLS port and reads its serial from the
/// certificate's common name. Returns None if it isn't a Bambu printer.
async fn read_serial(ip: IpAddr) -> Option<String> {
    let stream = timeout(Duration::from_secs(3), TcpStream::connect(SocketAddr::new(ip, PORT)))
        .await
        .ok()?
        .ok()?;
    let connector = TlsConnector::from(Arc::new(tls_config()));
    let tls = timeout(Duration::from_secs(3), connector.connect(ServerName::IpAddress(ip.into()), stream))
        .await
        .ok()?
        .ok()?;
    let cert = tls.get_ref().1.peer_certificates()?.first()?.clone();
    let (_, parsed) = x509_parser::parse_x509_certificate(&cert).ok()?;
    let issuer = parsed.issuer().to_string();
    if !issuer.contains("BBL") {
        return None;
    }
    parsed
        .subject()
        .iter_common_name()
        .next()?
        .as_str()
        .ok()
        .map(str::to_string)
}

/// Looks up the printer at `ip` (serial and model) so the user only has to
/// enter an IP address and access code.
#[tauri::command]
pub async fn printer_probe(ip: String) -> Result<FoundPrinter, String> {
    let addr: IpAddr = ip.trim().parse().map_err(|_| format!("Not an IP address: {ip}"))?;
    let serial = read_serial(addr)
        .await
        .ok_or_else(|| format!("No Bambu Lab printer answered at {ip}"))?;
    Ok(FoundPrinter { ip: addr.to_string(), model: model_from_serial(&serial), serial })
}

/// Runs `probe` on every address of the local /24 networks.
pub(crate) async fn scan_network<F, Fut>(probe: F) -> Vec<FoundPrinter>
where
    F: Fn(Ipv4Addr) -> Fut,
    Fut: Future<Output = Option<FoundPrinter>> + Send + 'static,
{
    let mut candidates = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if iface.is_loopback() {
            continue;
        }
        if let IpAddr::V4(v4) = iface.ip() {
            let [a, b, c, _] = v4.octets();
            for d in 1..=254u8 {
                let ip = Ipv4Addr::new(a, b, c, d);
                if ip != v4 {
                    candidates.push(ip);
                }
            }
        }
    }
    candidates.sort();
    candidates.dedup();

    // Probe in batches to stay well under file-descriptor limits.
    let mut found = Vec::new();
    let probes: Vec<_> = candidates.into_iter().map(probe).collect();
    let mut iter = probes.into_iter();
    loop {
        let batch: Vec<_> = iter.by_ref().take(128).collect();
        if batch.is_empty() {
            break;
        }
        let handles: Vec<_> = batch.into_iter().map(tauri::async_runtime::spawn).collect();
        for h in handles {
            if let Ok(Some(p)) = h.await {
                found.push(p);
            }
        }
    }
    found
}

/// Scans for Bambu printers. Used instead of SSDP discovery because desktop
/// firewalls usually drop the printers' broadcasts.
#[tauri::command]
pub async fn printer_scan() -> Vec<FoundPrinter> {
    scan_network(|ip| async move {
        let addr = SocketAddr::new(IpAddr::V4(ip), PORT);
        let open = matches!(timeout(Duration::from_millis(700), TcpStream::connect(addr)).await, Ok(Ok(_)));
        if !open {
            return None;
        }
        let serial = read_serial(IpAddr::V4(ip)).await?;
        Some(FoundPrinter { ip: ip.to_string(), model: model_from_serial(&serial), serial })
    })
    .await
}

/// Running status connections, by printer id.
#[derive(Default)]
pub struct Printers(Mutex<HashMap<String, JoinHandle<()>>>);

impl Printers {
    /// Runs `task` as the status connection for `id`, replacing any old one.
    pub(crate) fn start(&self, id: String, task: impl std::future::Future<Output = ()> + Send + 'static) {
        let mut map = self.0.lock().unwrap();
        if let Some(old) = map.remove(&id) {
            old.abort();
        }
        map.insert(id, tauri::async_runtime::spawn(task));
    }
}

#[derive(Serialize, Clone)]
struct StatusEvent<'a> {
    id: &'a str,
    connected: bool,
    error: Option<String>,
    /// The printer's merged `print` report (P1/A1 models only send changes).
    /// Other printers send the same fields, converted from their own APIs.
    print: &'a Value,
}

/// Sends a `printer-status` event for the frontend.
pub(crate) fn emit_status(app: &AppHandle, id: &str, connected: bool, error: Option<String>, print: &Value) {
    let _ = app.emit("printer-status", StatusEvent { id, connected, error, print });
}

/// Recursively merges `patch` into `base`; arrays and scalars are replaced.
fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                merge(b.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (b, p) => *b = p.clone(),
    }
}

async fn run(app: AppHandle, id: String, ip: String, serial: String, access_code: String) {
    let report_topic = format!("device/{serial}/report");
    let request_topic = format!("device/{serial}/request");
    let mut state = json!({});
    let mut last_log = String::new();

    let emit = |connected: bool, error: Option<String>, print: &Value| emit_status(&app, &id, connected, error, print);

    loop {
        let client_id = format!("3devil-{}", &uuid_suffix());
        let mut opts = MqttOptions::new(client_id, ip.clone(), PORT);
        opts.set_credentials("bblp", access_code.clone());
        opts.set_keep_alive(Duration::from_secs(30));
        // Full reports from X1 printers are larger than rumqttc's 10 KB default.
        opts.set_max_packet_size(4 * 1024 * 1024, 64 * 1024);
        opts.set_transport(Transport::tls_with_config(TlsConfiguration::Rustls(Arc::new(tls_config()))));
        let (client, mut events) = AsyncClient::new(opts, 16);

        let retry_after = loop {
            match events.poll().await {
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    println!("[printer {serial}] connected to {ip}");
                    let _ = client.subscribe(&report_topic, QoS::AtMostOnce).await;
                    let pushall = json!({"pushing": {"sequence_id": "0", "command": "pushall"}});
                    let _ = client
                        .publish(&request_topic, QoS::AtMostOnce, false, pushall.to_string())
                        .await;
                    emit(true, None, &state);
                }
                Ok(Event::Incoming(Packet::Publish(msg))) => {
                    let Ok(v) = serde_json::from_slice::<Value>(&msg.payload) else { continue };
                    let Some(print) = v.get("print") else { continue };
                    merge(&mut state, print);
                    let summary = format!(
                        "{} {}% layer {}/{} {}",
                        state["gcode_state"].as_str().unwrap_or("?"),
                        state["mc_percent"],
                        state["layer_num"],
                        state["total_layer_num"],
                        state["subtask_name"].as_str().unwrap_or(""),
                    );
                    if summary != last_log {
                        println!("[printer {serial}] {summary}");
                        last_log = summary;
                    }
                    emit(true, None, &state);
                }
                Ok(_) => {}
                Err(rumqttc::ConnectionError::ConnectionRefused(code)) => {
                    let msg = format!("Printer refused the connection ({code:?}). Check the access code.");
                    println!("[printer {serial}] {msg}");
                    emit(false, Some(msg), &state);
                    break Duration::from_secs(30);
                }
                Err(e) => {
                    println!("[printer {serial}] connection error: {e}");
                    emit(false, Some(format!("Can't reach printer at {ip}: {e}")), &state);
                    break Duration::from_secs(5);
                }
            }
        };
        tokio::time::sleep(retry_after).await;
    }
}

fn uuid_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", n & 0xffff_ffff)
}

/// Starts (or restarts) the status connection for one printer. Updates arrive
/// as `printer-status` events.
#[tauri::command]
pub fn printer_connect(
    app: AppHandle,
    printers: State<'_, Printers>,
    id: String,
    ip: String,
    serial: String,
    access_code: String,
) {
    printers.start(id.clone(), run(app, id, ip, serial, access_code));
}

#[tauri::command]
pub fn printer_disconnect(printers: State<'_, Printers>, id: String) {
    if let Some(h) = printers.0.lock().unwrap().remove(&id) {
        h.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_unchanged_fields() {
        let mut base = json!({"gcode_state": "RUNNING", "mc_percent": 10, "ams": {"tray_now": "1"}});
        merge(&mut base, &json!({"mc_percent": 11, "ams": {"ams_exist_bits": "1"}}));
        assert_eq!(base["gcode_state"], "RUNNING");
        assert_eq!(base["mc_percent"], 11);
        assert_eq!(base["ams"]["tray_now"], "1");
        assert_eq!(base["ams"]["ams_exist_bits"], "1");
    }

    #[test]
    fn model_names() {
        assert_eq!(model_from_serial("00M00A000000001"), "X1 Carbon");
        assert_eq!(model_from_serial("zzz"), "Bambu Lab printer");
    }
}
