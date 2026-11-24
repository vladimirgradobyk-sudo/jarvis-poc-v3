package com.mastercard.intent;

/**
 * Result of a successful registration.
 *
 * This type is part of the public response contract relied on by IntentController and
 * BatchIntentLoader. Adding a field is safe; changing or removing one is not.
 */
public class RegistrationResult {

    private final String intentId;
    private final String cartHash;

    public RegistrationResult(String intentId, String cartHash) {
        this.intentId = intentId;
        this.cartHash = cartHash;
    }

    public String getIntentId() { return intentId; }

    public String getCartHash() { return cartHash; }
}
