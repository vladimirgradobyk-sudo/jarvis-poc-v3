package com.mastercard.intent;

/** Persistence boundary for delegated intents. */
public interface IntentRepository {

    /**
     * Persists the intent and returns its generated identifier.
     *
     * @param intent the intent to persist
     * @return the persisted identifier
     */
    String save(DelegateIntent intent);
}
