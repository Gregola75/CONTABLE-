/* CONTABLE — seguridad: PIN de acceso y cifrado de copias de seguridad.
   El PIN nunca se guarda en claro (hash PBKDF2 con sal aleatoria) y las
   copias se cifran con AES-256-GCM derivando la clave de una contraseña. */

const SEGURIDAD = (() => {
  const CLAVE_LS = 'contable-sec';
  const ITERACIONES = 150000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ---------- utilidades base64 (por trozos, aguanta archivos grandes) ---------- */

  function bytesAB64(bytes) {
    let bin = '';
    const TROZO = 0x8000;
    for (let i = 0; i < bytes.length; i += TROZO) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + TROZO));
    }
    return btoa(bin);
  }

  function b64ABytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /* ---------- PIN de acceso ---------- */

  async function hashPIN(pin, saltB64 = null) {
    const salt = saltB64 ? b64ABytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const material = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: ITERACIONES, hash: 'SHA-256' }, material, 256);
    return { hash: bytesAB64(new Uint8Array(bits)), salt: bytesAB64(salt) };
  }

  function configPIN() {
    try { return JSON.parse(localStorage.getItem(CLAVE_LS) || 'null'); }
    catch { return null; }
  }

  function pinActivado() {
    return !!configPIN();
  }

  async function establecerPIN(pin) {
    const { hash, salt } = await hashPIN(pin);
    localStorage.setItem(CLAVE_LS, JSON.stringify({ hash, salt }));
  }

  async function verificarPIN(pin) {
    const c = configPIN();
    if (!c) return true;
    const { hash } = await hashPIN(pin, c.salt);
    return hash === c.hash;
  }

  function desactivarPIN() {
    localStorage.removeItem(CLAVE_LS);
  }

  /* ---------- Cifrado de copias de seguridad (AES-256-GCM) ---------- */

  async function claveAES(contrasena, salt) {
    const material = await crypto.subtle.importKey('raw', enc.encode(contrasena), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERACIONES, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /* Cifra un texto y devuelve el objeto listo para guardar en el archivo. */
  async function cifrarTexto(texto, contrasena) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const clave = await claveAES(contrasena, salt);
    const cifrado = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, clave, enc.encode(texto));
    return {
      app: 'CONTABLE',
      cifrado: true,
      version: 1,
      salt: bytesAB64(salt),
      iv: bytesAB64(iv),
      datos: bytesAB64(new Uint8Array(cifrado))
    };
  }

  /* Descifra el objeto de una copia protegida. Lanza error si la contraseña falla. */
  async function descifrarTexto(obj, contrasena) {
    const clave = await claveAES(contrasena, b64ABytes(obj.salt));
    try {
      const plano = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ABytes(obj.iv) }, clave, b64ABytes(obj.datos));
      return dec.decode(plano);
    } catch {
      throw new Error('Contraseña incorrecta o archivo dañado.');
    }
  }

  /* ---------- Desbloqueo biométrico (huella / cara) con WebAuthn ---------- */

  const CLAVE_BIO = 'contable-bio';

  /* ¿Tiene el dispositivo lector de huella/cara utilizable desde el navegador? */
  async function biometriaDisponible() {
    try {
      return !!(window.PublicKeyCredential &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch { return false; }
  }

  function biometriaActivada() {
    return !!localStorage.getItem(CLAVE_BIO);
  }

  /* Registra la huella del dispositivo para esta app. */
  async function activarBiometria() {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'CONTABLE', id: location.hostname },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'contable',
          displayName: 'CONTABLE'
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -257 }  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred'
        },
        timeout: 60000
      }
    });
    localStorage.setItem(CLAVE_BIO, bytesAB64(new Uint8Array(cred.rawId)));
  }

  /* Pide la huella al usuario. Devuelve true si la verificación es correcta. */
  async function verificarBiometria() {
    const idB64 = localStorage.getItem(CLAVE_BIO);
    if (!idB64) return false;
    try {
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: 'public-key', id: b64ABytes(idB64), transports: ['internal'] }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      return !!cred;
    } catch { return false; }
  }

  function desactivarBiometria() {
    localStorage.removeItem(CLAVE_BIO);
  }

  return {
    pinActivado, establecerPIN, verificarPIN, desactivarPIN,
    biometriaDisponible, biometriaActivada, activarBiometria, verificarBiometria, desactivarBiometria,
    cifrarTexto, descifrarTexto
  };
})();
