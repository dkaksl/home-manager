import { Agent } from 'undici'
import type { PeerCertificate } from 'tls'

// The bridge's TLS certificate is issued by Philips/Signify's own Hue root,
// not a public CA, so neither Node's default trust store nor the system one
// will accept it. `root-bridge` is what current BSB002 bridges chain to;
// `Hue Root CA 01` is Signify's newer root, which bridges move to after a
// certificate rotation. Both are self-signed and public.
export const HUE_ROOT_CAS = [
  `-----BEGIN CERTIFICATE-----
MIICMjCCAdigAwIBAgIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIw
OTELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAty
b290LWJyaWRnZTAiGA8yMDE3MDEwMTAwMDAwMFoYDzIwMzgwMTE5MDMxNDA3WjA5
MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxFDASBgNVBAMMC3Jv
b3QtYnJpZGdlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjNw2tx2AplOf9x86
aTdvEcL1FU65QDxziKvBpW9XXSIcibAeQiKxegpq8Exbr9v6LBnYbna2VcaK0G22
jOKkTqOBuTCBtjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNV
HQ4EFgQUZ2ONTFrDT6o8ItRnKfqWKnHFGmQwdAYDVR0jBG0wa4AUZ2ONTFrDT6o8
ItRnKfqWKnHFGmShPaQ7MDkxCzAJBgNVBAYTAk5MMRQwEgYDVQQKDAtQaGlsaXBz
IEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2WCFDuxUi22sYpLlwJY81Wrqy11phcO
MAoGCCqGSM49BAMCA0gAMEUCIEBYYEOsa07TH7E5MJnGw557lVkORgit2Rm1h3B2
sFgDAiEA1Fj/C3AN5psFMjo0//mrQebo0eKd3aWRx+pQY08mk48=
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIIBzDCCAXOgAwIBAgICEAAwCgYIKoZIzj0EAwIwPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTAgFw0y
NTAyMjUwMDAwMDBaGA8yMDUwMTIzMTIzNTk1OVowPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABFfOO0jfSAUXGQ9kjEDzyBrcMQ3ItyA5krE+
cyvb1Y3xFti7KlAad8UOnAx0FBLn7HZrlmIwm1QnX0fK3LPM13mjYzBhMB0GA1Ud
DgQWBBTF1pSpsCASX/z0VHLigxU2CAaqoTAfBgNVHSMEGDAWgBTF1pSpsCASX/z0
VHLigxU2CAaqoTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggq
hkjOPQQDAgNHADBEAiAk7duT+IHbOGO4UUuGLAEpyYejGZK9Z7V9oSfnvuQ5BQIg
IYSgwwxHXm73/JgcU9lAM6c8Bmu3UE3kBIUwBs1qXFw=
-----END CERTIFICATE-----`
]

// This home's bridge, the default when HUE_BRIDGE_ID isn't set (the same way
// HUE_IP defaults to its address). It's the lowercase `bridgeid` the bridge
// reports, also shown in the Hue app under Settings > Bridges.
export const DEFAULT_HUE_BRIDGE_ID = 'ecb5fafffe91e132'

// The bridge is reached by IP, but its certificate names the bridge ID in
// its CN rather than any hostname or IP SAN, so Node's default hostname
// check against HUE_IP always fails. Checking the CN against the expected
// bridge ID instead keeps the guarantee that matters: another device on the
// LAN can't stand in for this bridge, even another genuine Hue bridge.
export const createBridgeAgent = ({
  bridgeId,
  ca = HUE_ROOT_CAS
}: {
  bridgeId: string
  ca?: string[]
}) => {
  const expected = bridgeId.trim().toLowerCase()
  if (!expected) throw new Error('HUE_BRIDGE_ID_NOT_CONFIGURED')
  return new Agent({
    connect: {
      ca,
      rejectUnauthorized: true,
      checkServerIdentity: (host: string, cert: PeerCertificate) => {
        const cn = String(cert.subject?.CN ?? '').toLowerCase()
        if (cn === expected) return undefined
        return new Error(
          `Hue bridge at ${host} presented a certificate for bridge ID "${cn}", expected "${expected}" (HUE_BRIDGE_ID)`
        )
      }
    }
  })
}
