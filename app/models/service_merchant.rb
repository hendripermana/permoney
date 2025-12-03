class ServiceMerchant < Merchant
  # Service categories for subscription services
  CATEGORIES = %w[
    streaming software utilities subscriptions memberships insurance
    telecommunications cloud_services education entertainment health_wellness
    finance transportation food_delivery other
  ].freeze

  BILLING_FREQUENCIES = %w[monthly annual quarterly biennial one_time].freeze

  validates :subscription_category, inclusion: { in: CATEGORIES }, allow_nil: true
  validates :billing_frequency, inclusion: { in: BILLING_FREQUENCIES }, allow_nil: true
  validates :name, uniqueness: { scope: :type }
  validates :avg_monthly_cost, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true

  scope :popular, -> { where(popular: true) }
  scope :by_category, ->(category) { where(subscription_category: category) }
  scope :search, ->(query) {
    return all if query.blank?
    where("LOWER(name) LIKE ?", "%#{query.downcase}%")
  }

  def to_combobox_option
    ComboboxOption.new(
      id: id,
      name: name,
      logo_url: display_logo_url,
      category: subscription_category,
      billing_frequency: billing_frequency,
      avg_monthly_cost: avg_monthly_cost
    )
  end

  # Seed popular subscription services
  def self.seed_popular_services
    popular_services.each do |service_data|
      service = find_or_initialize_by(name: service_data[:name], type: "ServiceMerchant")
      service.assign_attributes(service_data.except(:name))
      service.website_url ||= derive_website_url(service_data[:name])

      # Fetch logo from Brandfetch if configured
      if Setting.brand_fetch_client_id.present? && service.logo_url.blank?
        service.logo_url = service.brandfetch_logo_url
      end

      service.save! if service.changed? || service.new_record?
    end
  end

  def self.derive_website_url(name)
    # Common service URL mappings
    mappings = {
      "Netflix" => "netflix.com",
      "Spotify Premium" => "spotify.com",
      "Disney+" => "disneyplus.com",
      "Amazon Prime Video" => "primevideo.com",
      "Hulu" => "hulu.com",
      "Apple TV+" => "tv.apple.com",
      "YouTube Premium" => "youtube.com",
      "HBO Max" => "max.com",
      "Apple Music" => "music.apple.com",
      "Adobe Creative Cloud" => "adobe.com",
      "Microsoft 365" => "microsoft.com",
      "Google Workspace" => "workspace.google.com",
      "Dropbox" => "dropbox.com",
      "Zoom" => "zoom.us",
      "Canva Pro" => "canva.com",
      "Notion" => "notion.so",
      "Slack" => "slack.com",
      "Figma" => "figma.com",
      "AWS" => "aws.amazon.com",
      "Google Cloud" => "cloud.google.com",
      "DigitalOcean" => "digitalocean.com",
      "Coursera" => "coursera.org",
      "MasterClass" => "masterclass.com",
      "LinkedIn Learning" => "linkedin.com/learning",
      "Headspace" => "headspace.com",
      "Calm" => "calm.com",
      "QuickBooks" => "quickbooks.intuit.com",
      "DoorDash" => "doordash.com",
      "Uber Eats" => "ubereats.com",
      "HelloFresh" => "hellofresh.com"
    }

    mappings[name] || "#{name.downcase.gsub(/[^a-z0-9]/, '')}.com"
  end

  def category_icon
    case subscription_category
    when "streaming" then "📺"
    when "software" then "💻"
    when "utilities" then "⚡"
    when "subscriptions" then "📦"
    when "memberships" then "🤝"
    when "insurance" then "🛡️"
    when "telecommunications" then "📡"
    when "cloud_services" then "☁️"
    when "education" then "📚"
    when "entertainment" then "🎮"
    when "health_wellness" then "🧘"
    when "finance" then "💰"
    when "transportation" then "🚗"
    when "food_delivery" then "🍔"
    else "📋"
    end
  end

  def display_name
    name
  end

  def monthly_equivalent_cost
    return avg_monthly_cost unless avg_monthly_cost.present?

    case billing_frequency
    when "annual" then avg_monthly_cost / 12.0
    when "quarterly" then avg_monthly_cost / 3.0
    when "biennial" then avg_monthly_cost / 24.0
    else avg_monthly_cost
    end
  end

  private

    def self.popular_services
      [
        # Streaming Services
        { name: "Netflix", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 15.99, popular: true },
        { name: "Spotify Premium", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 9.99, popular: true },
        { name: "Disney+", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 7.99, popular: true },
        { name: "Amazon Prime Video", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 8.99, popular: true },
        { name: "Hulu", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 7.99, popular: true },
        { name: "Apple TV+", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 4.99, popular: true },
        { name: "YouTube Premium", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 11.99, popular: true },
        { name: "HBO Max", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 15.99, popular: true },
        { name: "Apple Music", subscription_category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 10.99, popular: true },

        # Software & SaaS
        { name: "Adobe Creative Cloud", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 52.99, popular: true },
        { name: "Microsoft 365", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 6.99, popular: true },
        { name: "Google Workspace", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 6.00, popular: true },
        { name: "Dropbox", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 10.00, popular: true },
        { name: "Zoom", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 14.99, popular: true },
        { name: "Canva Pro", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 12.99, popular: true },
        { name: "Notion", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 8.00, popular: true },
        { name: "Slack", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 7.25, popular: true },
        { name: "Figma", subscription_category: "software", billing_frequency: "monthly", avg_monthly_cost: 15.00, popular: true },

        # Cloud Services
        { name: "AWS", subscription_category: "cloud_services", billing_frequency: "monthly", avg_monthly_cost: 50.00, popular: true },
        { name: "Google Cloud", subscription_category: "cloud_services", billing_frequency: "monthly", avg_monthly_cost: 40.00, popular: true },
        { name: "DigitalOcean", subscription_category: "cloud_services", billing_frequency: "monthly", avg_monthly_cost: 20.00, popular: true },

        # Education
        { name: "Coursera", subscription_category: "education", billing_frequency: "monthly", avg_monthly_cost: 59.00, popular: true },
        { name: "MasterClass", subscription_category: "education", billing_frequency: "annual", avg_monthly_cost: 15.00, popular: true },
        { name: "LinkedIn Learning", subscription_category: "education", billing_frequency: "monthly", avg_monthly_cost: 29.99, popular: true },

        # Health & Wellness
        { name: "Headspace", subscription_category: "health_wellness", billing_frequency: "monthly", avg_monthly_cost: 12.99, popular: true },
        { name: "Calm", subscription_category: "health_wellness", billing_frequency: "monthly", avg_monthly_cost: 14.99, popular: true },

        # Finance
        { name: "QuickBooks", subscription_category: "finance", billing_frequency: "monthly", avg_monthly_cost: 15.00, popular: true },

        # Food Delivery
        { name: "DoorDash", subscription_category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 9.99, popular: true },
        { name: "Uber Eats", subscription_category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 9.99, popular: true },
        { name: "HelloFresh", subscription_category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 60.00, popular: true }
      ]
    end
end
