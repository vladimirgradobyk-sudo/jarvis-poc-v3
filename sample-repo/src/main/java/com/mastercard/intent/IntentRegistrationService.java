package com.mastercard.intent;

import java.util.Objects;

/**
 * Registers an agentic intent and returns a registration result.
 *
 * Existing callers: IntentController (HTTP) and BatchIntentLoader (scheduled).
 * Both rely on the current response contract; any change here must preserve it.
 */
public class IntentRegistrationService {

    private final IntentRepository repository;
    private final DelegateIntentMapper mapper;

    public IntentRegistrationService(IntentRepository repository, DelegateIntentMapper mapper) {
        this.repository = Objects.requireNonNull(repository, "repository");
        this.mapper = Objects.requireNonNull(mapper, "mapper");
    }

    /**
     * Registers an intent.
     *
     * @param request the inbound intent, never null
     * @return the registration result carrying the persisted identifier
     */
    public RegistrationResult register(IntentRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        if (request.getCartHash() == null || request.getCartHash().isBlank()) {
            throw new IllegalArgumentException("cartHash must not be blank");
        }

        DelegateIntent intent = mapper.toDelegateIntent(request);
        String id = repository.save(intent);

        return new RegistrationResult(id, intent.getCartHash());
    }
}
