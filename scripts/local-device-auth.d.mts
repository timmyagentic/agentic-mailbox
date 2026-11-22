export function localDeviceAuth(certificatePath: string): {
  challenge(): { nonce: string; fingerprint: string } | null;
  prove(nonce: unknown, signature: unknown): boolean;
};
