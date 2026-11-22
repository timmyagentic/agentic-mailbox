import { X509Certificate, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const clientAuthUsage = '1.3.6.1.5.5.7.3.2';
const messagePrefix = 'Agentic Mailbox local login v1\n';

export function localDeviceAuth(certificatePath) {
  let active;

  function validCertificate() {
    try {
      const certificate = new X509Certificate(readFileSync(certificatePath));
      const now = Date.now();
      if (!certificate.ca && certificate.keyUsage?.includes(clientAuthUsage) &&
          ['rsa', 'ec'].includes(certificate.publicKey.asymmetricKeyType) &&
          now >= certificate.validFromDate.getTime() && now < certificate.validToDate.getTime()) {
        return certificate;
      }
    } catch {
      // Setup errors leave password login available.
    }
    return null;
  }

  return {
    challenge() {
      const certificate = validCertificate();
      if (!certificate) return null;
      const nonce = randomBytes(32).toString('hex');
      const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
      active = { nonce, fingerprint, expires: Date.now() + 60_000 };
      return { nonce, fingerprint };
    },
    prove(nonce, signature) {
      const issued = active;
      active = undefined;
      if (!issued || issued.nonce !== nonce || issued.expires <= Date.now() ||
          typeof signature !== 'string' || !/^[A-Za-z0-9+/=]{1,2048}$/.test(signature)) {
        return false;
      }
      const certificate = validCertificate();
      if (!certificate || certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== issued.fingerprint) return false;
      return verify('sha256', Buffer.from(messagePrefix + nonce), certificate.publicKey, Buffer.from(signature, 'base64'));
    },
  };
}
