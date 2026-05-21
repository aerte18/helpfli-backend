const {
  isExternalOrderPayment,
  allowsPlatformDispute,
  resolvePaymentFlow,
} = require("../../utils/orderPaymentFlow");

describe("orderPaymentFlow", () => {
  test("Stripe paymentMethod card does not mean external", () => {
    const order = { paymentPreference: "system", paymentMethod: "card" };
    expect(isExternalOrderPayment(order)).toBe(false);
    expect(resolvePaymentFlow(order)).toBe("system");
    expect(allowsPlatformDispute(order)).toBe(true);
  });

  test("external preference blocks dispute", () => {
    const order = { paymentPreference: "external", paymentMethod: "card" };
    expect(allowsPlatformDispute(order)).toBe(false);
  });

  test("paidInSystem allows dispute even without preference", () => {
    expect(allowsPlatformDispute({ paidInSystem: true, paymentStatus: "succeeded" })).toBe(true);
  });
});
