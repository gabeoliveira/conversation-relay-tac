import mockData from "../data/mock-data.js";

export interface CheckCardDeliveryParams {
  userId: string;
}

export async function checkCardDelivery(params: CheckCardDeliveryParams): Promise<string> {
  console.log("Checking Card Delivery Status", params);
  const user = mockData.users.find((user) => user.userId === params.userId);
  if (user && "bankAccount" in user && user.bankAccount?.cardDelivery) {
    return JSON.stringify({ userId: params.userId, cardDelivery: user.bankAccount.cardDelivery });
  }
  return "No card delivery data found.";
}
