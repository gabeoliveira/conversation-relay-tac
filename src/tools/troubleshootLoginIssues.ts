import mockData from "../data/mock-data.js";

export interface TroubleshootLoginIssuesParams {
  userId: string;
}

export async function troubleshootLoginIssues(params: TroubleshootLoginIssuesParams): Promise<string> {
  console.log("Troubleshooting login issues", params);
  const user = mockData.users.find((user) => user.userId === params.userId);
  if (user && "login" in user && user.login) {
    return JSON.stringify({ userId: params.userId, login: user.login });
  }
  return "No login data found.";
}
