import mockData from "../data/mock-data.js";

export interface SearchCommonMedicalTermsParams {
  inquiry: "DEDUCTIBLE" | "COPAY" | "HSA" | "OUT_OF_POCKET_MAX";
}

export async function searchCommonMedicalTerms(params: SearchCommonMedicalTermsParams): Promise<string> {
  const normalizedInquiry = params.inquiry.toUpperCase();

  const inquiryKeyMap: { [key: string]: keyof typeof mockData.common_terms } = {
    DEDUCTIBLE: "deductible",
    COPAY: "copay",
    HSA: "hsa",
    OUT_OF_POCKET_MAX: "out_of_pocket_max",
  };

  const term = mockData.common_terms[inquiryKeyMap[normalizedInquiry]];
  return (
    term ||
    "No information found. Please let the caller know that you could not find the information they were looking for."
  );
}
