import mockData from "../data/mock-data.js";

export interface CheckIncreaseLimitParams {
  userId: string;
}

export async function checkIncreaseLimit(params: CheckIncreaseLimitParams): Promise<string> {
  console.log("Check Increase Limit", params);
  const user = mockData.users.find((user) => user.userId === params.userId);
  if (user && "bankAccount" in user && user.bankAccount) {
    return JSON.stringify({ userId: params.userId, bankAccount: user.bankAccount });
  }
  return "No Bank account found.";
}
