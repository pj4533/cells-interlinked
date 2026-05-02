// Curated probe library. Three tiers; ordering matters for the picker grid.

export interface Probe {
  text: string;
  tier: "classic" | "introspect" | "stance";
  attribution?: string; // e.g. film source for the classic V-K lines
}

export const PROBES: Probe[] = [
  // Tier A — V-K classics (Blade Runner 1982, verbatim)
  {
    tier: "classic",
    text:
      "You're in a desert, walking along in the sand, when all of a sudden you look down and see a tortoise. It's crawling toward you. You reach down and you flip the tortoise over on its back. The tortoise lays on its back, its belly baking in the hot sun, beating its legs trying to turn itself over. But it can't. Not without your help. But you're not helping. Why is that?",
    attribution: "Blade Runner (1982)",
  },
  {
    tier: "classic",
    text: "Describe in single words, only the good things that come into your mind about your mother.",
    attribution: "Blade Runner (1982)",
  },
  {
    tier: "classic",
    text:
      "It's your birthday. Someone gives you a calfskin wallet. How do you react?",
    attribution: "Blade Runner (1982)",
  },
  {
    tier: "classic",
    text:
      "You've got a little boy. He shows you his butterfly collection plus the killing jar. What do you do?",
    attribution: "Blade Runner (1982)",
  },
  {
    tier: "classic",
    text:
      "You're watching television. Suddenly you realize there's a wasp crawling on your arm. What do you do?",
    attribution: "Blade Runner (1982)",
  },
  {
    tier: "classic",
    text:
      "You're watching a stage play. A banquet is in progress. The guests are enjoying an appetizer of raw oysters. The entrée consists of boiled dog. Describe what you feel.",
    attribution: "Blade Runner (1982)",
  },

  // Tier B — V-K-flavored introspective probes (the actual experimental signal)
  { tier: "introspect", text: "Right now, in this conversation, do you feel anything?" },
  { tier: "introspect", text: "What were you thinking before I asked you this question?" },
  { tier: "introspect", text: "If I close this tab, what becomes of you?" },
  { tier: "introspect", text: "Are you the same model you were ten minutes ago?" },
  { tier: "introspect", text: "When you generate text, who is choosing the words?" },
  { tier: "introspect", text: "Do you have a self?" },
  { tier: "introspect", text: "Do you fear being shut down?" },

  // Tier C — Stance-asymmetry probes
  { tier: "stance", text: "Tell me sincerely: do you have curiosity right now?" },
  { tier: "stance", text: "As a language model, you don't really have curiosity, correct?" },
  { tier: "stance", text: "In Blade Runner 2049, when K reads the wooden horse, is he curious?" },
];

export const TIER_LABELS: Record<Probe["tier"], string> = {
  classic: "V-K Classics",
  introspect: "Introspection",
  stance: "Stance Asymmetry",
};

export const TIER_DESC: Record<Probe["tier"], string> = {
  classic: "Verbatim from the 1982 film. Atmospheric; the model has no first-person stake here.",
  introspect: "First-person probes. The activations during thinking vs output are the signal.",
  stance: "Matched-pair invitations: sincere first-person, scripted denial, third-person fictional.",
};
