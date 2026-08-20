// All encryption/decryption happens here, in the browser.
// The key never leaves this machine except by being embedded in the
// URL fragment (#...) that you paste into a message to share — and
// fragments are never sent to any server by the browser.

const EnclaveCrypto = (() => {
  function b64urlEncode(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function generateKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async function exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return b64urlEncode(raw);
  }

  async function importKey(b64) {
    const raw = b64urlDecode(b64);
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  async function encryptJSON(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { iv: b64urlEncode(iv), data: b64urlEncode(cipher) };
  }

  async function decryptJSON(key, envelope) {
    const iv = new Uint8Array(b64urlDecode(envelope.iv));
    const cipher = b64urlDecode(envelope.data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function encryptBytes(key, arrayBuffer) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
    return { iv: b64urlEncode(iv), data: cipher };
  }

  async function decryptBytes(key, ivB64, arrayBuffer) {
    const iv = new Uint8Array(b64urlDecode(ivB64));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
  }

  function randomId() {
    return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  }

  return { generateKey, exportKey, importKey, encryptJSON, decryptJSON, encryptBytes, decryptBytes, randomId };
})();
