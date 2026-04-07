const mockData = {
  users: [
    { firstName: "Roberto",
      lastName: "Velázquez",
      userId: "123456",
      dob: "1990-05-01",
      login: {
        lastLogin: "2025-03-27",
        loginCount: 5,
        failedLoginCount: 2,
        locked: false,
      },
      bankAccount: {
        balance: 1000,
        lastDeposit: "2025-03-27",
        currentGeneralLimit: 15000,
        approvedGeneralLimit: 18000,
        creditCard: {
          balance: 500,
          dueDate: "2025-04-05",
          minimumPayment: 250,
          creditLimit: 10000,
          approvedCreditLimit: 12000,
        },
        cardDelivery: {
          address: "123 Main St, Anytown, USA",
          status: "Pending",
          date: "2025-03-27",
          time: "05:00 PM",
        },
      },
    },
    {
      firstName: "John",
      lastName: "Doe",
      userId: "user123",
      dob: "1990-05-01",
      hsaAccount: {
        balance: 1200,
        lastContribution: "2024-09-01",
      },
    },
    {
      firstName: "Jane",
      lastName: "Smith",
      userId: "user456",
      dob: "1985-05-15",
      hsaAccount: {
        balance: 800,
        lastContribution: "2024-08-01",
      },
    },
    {
      firstName: "Alice",
      lastName: "Johnson",
      userId: "user789",
      dob: "1992-07-20",
      hsaAccount: undefined,
    },
  ],

  bills: [
    {
      userId: "user123",
      visit: {
        date: "2024-10-01",
        hospital: "XYZ Hospital",
      },
      bill: {
        copay: 150,
        total: 750,
        balance_due: 600,
        reason_for_balance: "Deductible not met",
        insurance: {
          provider: "Aetna",
          plan: "Gold",
          deductible: 1000,
          deductible_met: false,
        },
      },
    },
    {
      userId: "user456",
      visit: {
        date: "2024-11-15",
        hospital: "DEF Hospital",
      },
      bill: {
        copay: 100,
        total: 700,
        balance_due: 600,
        reason_for_balance: "Deductible not met",
        insurance: {
          provider: "UnitedHealthcare",
          plan: "Platinum",
          deductible: 800,
          deductible_met: false,
        },
      },
    },
    {
      userId: "user789",
      visit: {
        date: "2024-12-20",
        hospital: "GHI Hospital",
      },
      bill: {
        copay: 200,
        total: 850,
        balance_due: 650,
        reason_for_balance: "Deductible not met",
        insurance: {
          provider: "Cigna",
          plan: "Bronze",
          deductible: 1000,
          deductible_met: false,
        },
      },
    },
  ],

  common_terms: {
    deductible:
      "Deductibles are the amount of money you have to pay for covered health care services before your insurance plan starts to pay. After you pay your deductible, you usually pay only a copayment or coinsurance for covered services. Your insurance company pays the rest.",
    copay:
      "A copayment or copay is a fixed amount for a covered service, paid by a patient to the provider of service before receiving the service. It may be defined in an insurance policy and paid by an insured person each time a medical service is accessed.",
    hsa: "A health savings account (HSA) is a tax-advantaged medical savings account available to taxpayers in the United States who are enrolled in a high-deductible health plan (HDHP). The funds contributed to an account are not subject to federal income tax at the time of deposit.",
    out_of_pocket_max:
      "The most you have to pay for covered services in a plan year. After you spend this amount on deductibles, copayments, and coinsurance, your health plan pays 100% of the costs of covered benefits.",
  },
};

export default mockData;
