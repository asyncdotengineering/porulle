import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Porulle",
      description:
        "TypeScript headless commerce framework — REST-only, security-hardened, plugin architecture (v0.1.0 alpha).",
      logo: { src: "./public/logo.svg", alt: "Porulle" },
      favicon: "/logo.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/asyncdotengineering/porulle",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/asyncdotengineering/porulle/edit/main/apps/docs/",
      },
      lastUpdated: true,
      pagination: true,
      pagefind: true,
      customCss: ["./src/styles/porulle.css"],
      sidebar: [
        {
          label: "Get Started",
          items: [
            { label: "Introduction", slug: "get-started/intro" },
            { label: "Install", slug: "get-started/install" },
            { label: "Quickstart", slug: "get-started/quickstart" },
          ],
        },
        {
          label: "Building a Store",
          items: [
            { label: "Overview", slug: "building" },
            { label: "Authentication", slug: "building/authentication" },
            { label: "Store Settings", slug: "building/settings" },
            { label: "Provisioning via SDK", slug: "building/admin-via-sdk" },
            { label: "Email Notifications", slug: "building/email" },
            { label: "Analytics", slug: "building/analytics" },
            { label: "Receipts & Invoices", slug: "building/receipts-and-invoices" },
            { label: "Tax Classes", slug: "building/tax" },
            { label: "Refunds & Exchanges", slug: "building/refunds-and-exchanges" },
            { label: "Gift Cards", slug: "building/gift-cards" },
            { label: "Point of Sale", slug: "building/pos" },
            { label: "Layaway", slug: "building/layaway" },
            { label: "Supply Chain", slug: "building/supply-chain" },
          ],
        },
        {
          label: "Extending Porulle",
          items: [
            { label: "Overview", slug: "extending" },
            { label: "Hooks", slug: "extending/hooks" },
            { label: "Custom Tables", slug: "extending/custom-tables" },
            { label: "Payment Adapter", slug: "extending/payment-adapter" },
            { label: "Plugin Contract", slug: "extending/plugin-contract" },
            { label: "Payment Adapter Contract", slug: "extending/payment-adapter-contract" },
            { label: "Testing", slug: "extending/testing" },
            { label: "TypeScript Patterns", slug: "extending/typescript" },
          ],
        },
        {
          label: "Frontend Integration",
          items: [
            { label: "Overview", slug: "frontend" },
            { label: "Next.js", slug: "frontend/nextjs" },
            { label: "TanStack Start", slug: "frontend/tanstack-start" },
            { label: "Typed SDK Client", slug: "frontend/sdk" },
          ],
        },
        {
          label: "Running in Production",
          items: [
            { label: "Overview", slug: "production" },
            { label: "Deploy", slug: "production/deployment" },
            { label: "Multi-Tenancy", slug: "production/multi-tenancy" },
            { label: "Webhooks and Audit", slug: "production/webhooks-and-audit" },
            { label: "Security Model", slug: "production/security-model" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Overview", slug: "reference" },
            { label: "Packages", slug: "reference/packages" },
            { label: "REST API", slug: "reference/rest-api" },
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Hooks", slug: "reference/hooks" },
            { label: "Plugins", slug: "reference/plugins" },
            { label: "Adapters", slug: "reference/adapters" },
            { label: "Analytics", slug: "reference/analytics" },
            { label: "Job Queue", slug: "reference/jobs" },
            { label: "Database Schema", slug: "reference/database-schema" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Overview", slug: "concepts" },
            { label: "The Thesis", slug: "concepts/thesis" },
            { label: "Architecture", slug: "concepts/architecture" },
            { label: "The Entity Model", slug: "concepts/entity-model" },
            { label: "Plugin Architecture", slug: "concepts/plugin-architecture" },
            { label: "Hook Pipeline", slug: "concepts/hook-pipeline" },
            { label: "Result Types", slug: "concepts/result-types" },
            { label: "Identity and Store Resolution", slug: "concepts/identity-model" },
            { label: "The Full Thesis (founding RFC)", slug: "concepts/full-thesis" },
          ],
        },
        {
          label: "Tutorials",
          items: [
            { label: "Overview", slug: "tutorials" },
            { label: "Your First Store", slug: "tutorials/first-store" },
            { label: "Build a Loyalty Plugin", slug: "tutorials/build-a-plugin" },
            { label: "Tea Shop POS", slug: "tutorials/tea-shop-pos" },
          ],
        },
        {
          label: "Changelog",
          items: [{ label: "v0.8.0", slug: "changelog" }],
        },
      ],
    }),
  ],
});
