jest.mock('../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../models/Company', () => ({ findById: jest.fn() }));

const User = require('../../models/User');
const Company = require('../../models/Company');
const { requireCompanyAccess } = require('../../middleware/companyMiddleware');

function responseMock() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('company access boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('manager receives view and management scope', async () => {
    const user = { _id: 'user-1', role: 'provider', company: 'company-1' };
    const company = {
      _id: { toString: () => 'company-1' },
      canAccess: jest.fn().mockReturnValue(true),
      canManage: jest.fn().mockReturnValue(true),
    };
    User.findById.mockResolvedValue(user);
    Company.findById.mockResolvedValue(company);
    const req = { user: { _id: 'user-1' }, params: { companyId: 'company-1' }, body: {} };
    const res = responseMock();
    const next = jest.fn();

    await requireCompanyAccess(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.companyId).toBe('company-1');
    expect(req.companyAccess).toEqual({ canManage: true, canView: true });
  });

  test('employee can view company resources but cannot manage them', async () => {
    User.findById.mockResolvedValue({ _id: 'user-2', role: 'provider', company: 'company-1' });
    Company.findById.mockResolvedValue({
      _id: { toString: () => 'company-1' },
      canAccess: jest.fn().mockReturnValue(true),
      canManage: jest.fn().mockReturnValue(false),
    });
    const req = { user: { _id: 'user-2' }, params: { companyId: 'company-1' }, body: {} };
    const res = responseMock();
    const next = jest.fn();

    await requireCompanyAccess(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.companyAccess).toEqual({ canManage: false, canView: true });
  });

  test('user from another company is rejected', async () => {
    User.findById.mockResolvedValue({ _id: 'user-3', role: 'provider' });
    Company.findById.mockResolvedValue({
      _id: { toString: () => 'company-1' },
      canAccess: jest.fn().mockReturnValue(false),
      canManage: jest.fn().mockReturnValue(false),
    });
    const req = { user: { _id: 'user-3' }, params: { companyId: 'company-1' }, body: {} };
    const res = responseMock();
    const next = jest.fn();

    await requireCompanyAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
