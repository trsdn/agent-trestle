export function assertWorkSignatureProvider(provider) {
  if (!provider || typeof provider.getSignature !== "function") {
    throw new TypeError(
      "workSignatureProvider must implement async getSignature(context)",
    );
  }
  return provider;
}

export async function readWorkSignature(provider, context) {
  assertWorkSignatureProvider(provider);
  const signature = await provider.getSignature(context);
  if (typeof signature !== "string" || signature.length === 0) {
    throw new TypeError("getSignature() must return a non-empty string");
  }
  return signature;
}

export function createWorkSignatureProvider(getSignature) {
  return assertWorkSignatureProvider({ getSignature });
}

