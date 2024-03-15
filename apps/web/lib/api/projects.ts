import { deleteDomainAndLinks } from "@/lib/api/domains";
import prisma from "@/lib/prisma";
import { cancelSubscription } from "@/lib/stripe";
import { DUB_DOMAINS_ARRAY, LEGAL_PROJECT_ID, LEGAL_USER_ID } from "@dub/utils";
import { r2 } from "../r2";
import { ProjectProps } from "../types";
import { redis } from "../upstash";

export async function deleteProject(
  project: Pick<ProjectProps, "id" | "slug" | "stripeId" | "logo">,
) {
  const [customDomains, defaultDomainLinks] = await Promise.all([
    prisma.domain.findMany({
      where: {
        projectId: project.id,
      },
      select: {
        slug: true,
      },
    }),
    prisma.link.findMany({
      where: {
        projectId: project.id,
        domain: {
          in: DUB_DOMAINS_ARRAY,
        },
      },
      select: {
        domain: true,
        key: true,
        proxy: true,
      },
    }),
  ]);

  const linksByDomain: Record<string, string[]> = {};
  defaultDomainLinks.forEach(async (link) => {
    const { domain, key } = link;

    if (!linksByDomain[domain]) {
      linksByDomain[domain] = [];
    }
    linksByDomain[domain].push(key.toLowerCase());
  });

  const pipeline = redis.pipeline();

  Object.entries(linksByDomain).forEach(([domain, links]) => {
    pipeline.hdel(domain, ...links);
  });

  // delete all domains, links, and uploaded images associated with the project
  const deleteDomainsLinksResponse = await Promise.allSettled([
    ...customDomains.map(({ slug }) =>
      deleteDomainAndLinks(slug, {
        // here, we don't need to delete in prisma because we're deleting the project later and have onDelete: CASCADE set
        skipPrismaDelete: true,
      }),
    ),
    // delete all default domain links from redis
    pipeline.exec(),
    // remove all images from R2
    ...defaultDomainLinks.map(({ domain, key, proxy }) =>
      proxy ? r2.delete(`${domain}/${key}`) : Promise.resolve(),
    ),
  ]);

  const deleteProjectResponse = await Promise.all([
    // delete project logo from R2
    project.logo && r2.delete(`logos/${project.id}`),
    // if they have a Stripe subscription, cancel it
    project.stripeId && cancelSubscription(project.stripeId),
    // delete the project
    prisma.project.delete({
      where: {
        slug: project.slug,
      },
    }),
  ]);

  return {
    deleteDomainsLinksResponse,
    deleteProjectResponse,
  };
}

export async function deleteProjectAdmin(
  project: Pick<ProjectProps, "id" | "slug" | "stripeId" | "logo">,
) {
  const [customDomains, _] = await Promise.all([
    prisma.domain.findMany({
      where: {
        projectId: project.id,
      },
      select: {
        slug: true,
      },
    }),
    prisma.link.updateMany({
      where: {
        projectId: project.id,
        domain: {
          in: DUB_DOMAINS_ARRAY,
        },
      },
      data: {
        userId: LEGAL_USER_ID,
        projectId: LEGAL_PROJECT_ID,
      },
    }),
  ]);

  // delete all domains, links, and uploaded images associated with the project
  const deleteDomainsLinksResponse = await Promise.allSettled([
    ...customDomains.map(({ slug }) =>
      deleteDomainAndLinks(slug, {
        // here, we don't need to delete in prisma because we're deleting the project later and have onDelete: CASCADE set
        skipPrismaDelete: true,
      }),
    ),
  ]);

  const deleteProjectResponse = await Promise.all([
    // delete project logo from R2
    project.logo && r2.delete(`logos/${project.id}`),
    // if they have a Stripe subscription, cancel it
    project.stripeId && cancelSubscription(project.stripeId),
    // delete the project
    prisma.project.delete({
      where: {
        slug: project.slug,
      },
    }),
  ]);

  return {
    deleteDomainsLinksResponse,
    deleteProjectResponse,
  };
}
