require "pagy"
require "pagy/toolbox/helpers/support/series"

# Preserve legacy per_page query parameter in pagination links so our UI keeps
# the selected page size when navigating.
Pagy.options[:limit_key] = "per_page"

# Favour a graceful fallback instead of raising when a page number is out of
# range (e.g. when Google crawls a stale page).
Pagy.options[:overflow] = :last_page

# Custom helper exposing Pagy's internal series builder so we can keep the
# existing Tailwind-friendly pagination component without relying on the
# deprecated frontend helpers.
class Pagy
  def navigation_series(**options)
    series(**options)
  end
end
