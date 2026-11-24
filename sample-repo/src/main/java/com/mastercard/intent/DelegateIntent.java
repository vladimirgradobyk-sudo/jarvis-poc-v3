package com.mastercard.intent;

/** Internal representation of a delegated agentic intent. */
public class DelegateIntent {

    private String cartHash;
    private String merchantId;
    private String channel;

    public String getCartHash() { return cartHash; }
    public void setCartHash(String cartHash) { this.cartHash = cartHash; }

    public String getMerchantId() { return merchantId; }
    public void setMerchantId(String merchantId) { this.merchantId = merchantId; }

    public String getChannel() { return channel; }
    public void setChannel(String channel) { this.channel = channel; }
}
