package com.mastercard.intent;

/** Maps an inbound request onto the internal delegate-intent model. */
public class DelegateIntentMapper {

    public DelegateIntent toDelegateIntent(IntentRequest request) {
        DelegateIntent intent = new DelegateIntent();
        intent.setCartHash(request.getCartHash());
        intent.setMerchantId(request.getMerchantId());
        intent.setChannel(request.getChannel());
        return intent;
    }
}
