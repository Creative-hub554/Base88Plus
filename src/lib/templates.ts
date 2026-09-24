import { createHash } from "node:crypto";

/**
 * Template catalog shared by the /new gallery (client) and the server-side
 * generator. One entry per starter card.
 */
export interface TemplateDef {
  id: string;
  name: string;
  tagline: string;
  appName: string;
  brief: string;
  /** Tailwind gradient classes for the fallback card visual. */
  gradient: string;
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: "landing",
    name: "Product landing page",
    tagline: "Hero, features, social proof, pricing teaser, CTA footer",
    appName: "Landing Page",
    brief:
      "A premium product landing page for a modern SaaS tool. Above the fold: bold headline, subheadline, primary CTA button and a hero visual (CSS/SVG illustration, no external images). Sections: logo strip, 6 feature cards in a responsive grid, a stats band, one testimonial, pricing teaser with 3 tiers, FAQ, and a final CTA footer. Sticky glassy navbar with smooth-scroll anchor links; footer with columns and copyright.",
    gradient: "from-indigo-500 via-purple-500 to-pink-500",
  },
  {
    id: "portfolio",
    name: "Portfolio",
    tagline: "Case-study grid, about section, contact links",
    appName: "Portfolio",
    brief:
      "A personal portfolio site for a designer/developer. Hero with name, role and short bio; a filterable project grid (6+ case-study cards with CSS-drawn thumbnails and hover lift); an about section with skills; a contact section with email and social links. Elegant, typography-led, generous whitespace.",
    gradient: "from-amber-400 via-orange-500 to-rose-500",
  },
  {
    id: "restaurant",
    name: "Restaurant",
    tagline: "Menu, hours, reservation form, map placeholder",
    appName: "Restaurant Site",
    brief:
      "A restaurant website: warm, appetite-driven design. Hero with restaurant name and reservation CTA; an interactive menu (tabbed categories, items with prices); opening hours; a reservation form with validation and success state (localStorage-backed); a location section with a stylized CSS map placeholder; footer with contact info.",
    gradient: "from-emerald-500 via-teal-500 to-cyan-500",
  },
  {
    id: "saas",
    name: "SaaS site",
    tagline: "Features, integrations, pricing table, multiple pages",
    appName: "SaaS Site",
    brief:
      "A multi-page SaaS marketing site: index.html (hero, feature grid, integrations logos, pricing table with monthly/yearly toggle), pricing.html (detailed comparison table), about.html (team, story), contact.html (form with validation). Shared navbar and footer across all pages; consistent design system; responsive at 390px/768px.",
    gradient: "from-sky-500 via-blue-600 to-indigo-600",
  },
  {
    id: "event",
    name: "Event page",
    tagline: "Schedule, speakers, tickets with countdown",
    appName: "Event Site",
    brief:
      "A conference/event site: bold hero with date, venue and a live countdown timer; schedule with day tabs; speaker grid with CSS-drawn avatars; ticket tiers with a working registration form (localStorage, success + validation states); FAQ accordion; footer with sponsors row.",
    gradient: "from-fuchsia-500 via-rose-500 to-orange-400",
  },
  {
    id: "blog",
    name: "Blog",
    tagline: "Post grid, single-post view, categories, newsletter",
    appName: "Blog",
    brief:
      "A clean multi-page blog: index.html with a featured post and a post grid; post.html reading a shared posts.js data file and rendering the selected post; about page; newsletter signup with validation. Category filtering, reading-time labels, and a typographic, readable layout.",
    gradient: "from-lime-400 via-green-500 to-emerald-600",
  },
];

/** Library project id for a template: templates are generated once, not per user. */
export function templateProjectId(templateId: string): string {
  return `tpl-${templateId}`;
}

/**
 * Cache key: briefs are edited between releases, so a stale library project
 * (old brief) is detected by hashing the brief it was generated from.
 */
export function briefHash(brief: string): string {
  return createHash("sha256").update(brief, "utf8").digest("hex").slice(0, 16);
}
