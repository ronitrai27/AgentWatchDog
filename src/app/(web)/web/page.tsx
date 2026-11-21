import { Hero } from "@/components/hero";
import { RoxFooter } from "@/components/rox-footer";
import { SiteHeader } from "@/components/site-header";

export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
      </main>
      <RoxFooter />
    </>
  );
}
