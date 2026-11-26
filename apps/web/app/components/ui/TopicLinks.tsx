import type { TopicLink } from "@aihot/contracts/site";
import { topicName } from "@aihot/contracts/taxonomy";
import { useLocale } from "../../lib/i18n";
import { Link } from "../../lib/link";

export function TopicLinks({ topics }: { topics: TopicLink[] }) {
  const locale = useLocale();
  return topics.map((topic) => (
    <Link viewTransition key={topic.slug} to={`/topics/${topic.slug}`} className="chip">
      {topicName(topic.slug, topic.name, locale)}
    </Link>
  ));
}
