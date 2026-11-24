package com.mastercard.intent;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

/**
 * Existing behaviour tests. Any change to IntentRegistrationService must keep these passing —
 * they encode the response contract that IntentController and BatchIntentLoader depend on.
 */
class IntentRegistrationServiceTest {

    private final IntentRepository repository = intent -> "intent-1";
    private final DelegateIntentMapper mapper = new DelegateIntentMapper();
    private final IntentRegistrationService service = new IntentRegistrationService(repository, mapper);

    @Test
    void registersAnIntentAndReturnsItsIdentifier() {
        IntentRequest request = new IntentRequest();
        request.setCartHash("abc123");
        request.setMerchantId("M-77");
        request.setChannel("web");

        RegistrationResult result = service.register(request);

        assertEquals("intent-1", result.getIntentId());
        assertEquals("abc123", result.getCartHash());
    }

    @Test
    void rejectsANullRequest() {
        assertThrows(IllegalArgumentException.class, () -> service.register(null));
    }

    @Test
    void rejectsABlankCartHash() {
        IntentRequest request = new IntentRequest();
        request.setCartHash("   ");

        assertThrows(IllegalArgumentException.class, () -> service.register(request));
    }
}
