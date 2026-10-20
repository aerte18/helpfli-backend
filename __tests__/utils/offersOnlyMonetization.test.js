const {
  maskNonAcceptedOfferContacts,
} = require('../../utils/offersOnlyMonetization');

describe('offers-only contact privacy', () => {
  test('an unlock reveals only the accepted provider contact', () => {
    const order = {
      acceptedOfferId: { _id: 'offer-accepted' },
      offers: [
        {
          _id: 'offer-accepted',
          providerId: { email: 'accepted@example.com', phone: '501234567' },
        },
        {
          _id: 'offer-rejected',
          providerId: { email: 'other@example.com', phone: '509876543' },
        },
      ],
    };

    maskNonAcceptedOfferContacts(order);

    expect(order.offers[0].providerId).toEqual({
      email: 'accepted@example.com',
      phone: '501234567',
    });
    expect(order.offers[1].providerId).toEqual(expect.objectContaining({
      email: 'o***@example.com',
      phone: '*** *** 543',
      emailLocked: true,
      phoneLocked: true,
    }));
  });

  test('fails closed and masks every offer when no accepted offer is bound', () => {
    const order = {
      acceptedOfferId: null,
      offers: [{
        _id: 'offer-1',
        providerId: { email: 'provider@example.com', phone: '500000123' },
      }],
    };

    maskNonAcceptedOfferContacts(order);

    expect(order.offers[0].providerId.email).toBe('p***@example.com');
    expect(order.offers[0].providerId.phone).toBe('*** *** 123');
  });
});
