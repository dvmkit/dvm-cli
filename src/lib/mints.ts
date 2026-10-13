
export interface MintRecommendation {
  name: string;
  description: string;
  url: string;

  comparison?: string;
}

export const RECOMMENDED_MINTS: MintRecommendation[] = [
  {
    name: "Coinos",
    description: "Primary Cashu mint accepted by dvmkit DVMs",
    url: "https://mint.coinos.io",
  },
  {
    name: "Voltz Mint",
    description: "Fallback Cashu mint accepted by dvmkit DVMs",
    url: "https://mint.lnvoltz.com",
  },
];
