class ServiceMerchant < Merchant
  # Service categories for subscription services
  CATEGORIES = %w[
    streaming software utilities subscriptions memberships insurance
    telecommunications cloud_services education entertainment health_wellness
    finance transportation food_delivery housing energy water internet
    mobile_phone garbage security parking gym other
  ].freeze

  # Utility-specific categories for recurring bills
  UTILITY_CATEGORIES = %w[
    utilities housing energy water internet mobile_phone garbage
    security parking
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
      avg_monthly_cost: avg_monthly_cost,
      formatted_cost: formatted_avg_monthly_cost
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
    when "housing" then "🏠"
    when "energy" then "💡"
    when "water" then "💧"
    when "internet" then "🌐"
    when "mobile_phone" then "📱"
    when "garbage" then "🗑️"
    when "security" then "🔒"
    when "parking" then "🅿️"
    when "gym" then "💪"
    else "📋"
    end
  end

  # Check if this service is a utility
  def utility?
    UTILITY_CATEGORIES.include?(subscription_category)
  end

  def display_name
    name
  end

  # Required by hotwire_combobox for async combobox prefill (edit mode)
  # When editing a record with an existing merchant_id, the gem looks up the ServiceMerchant
  # and calls to_combobox_display directly on it to show the selected value
  def to_combobox_display
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

  # Returns the source currency for avg_monthly_cost
  # Popular services: seeded with USD prices
  # Custom services: assumed to be in the user's family currency
  def avg_cost_currency
    popular? ? "USD" : (Current.family&.currency || "USD")
  end

  # Returns avg_monthly_cost as Money object with proper currency
  def avg_monthly_cost_money
    return nil unless avg_monthly_cost.present? && avg_monthly_cost > 0
    Money.new(avg_monthly_cost, avg_cost_currency)
  end

  # Returns avg_monthly_cost converted to target currency (default: user's family currency)
  # Uses existing ExchangeRate system for conversion
  def avg_monthly_cost_in(target_currency = nil)
    return nil unless avg_monthly_cost.present? && avg_monthly_cost > 0

    target = target_currency || Current.family&.currency || "USD"
    source = avg_cost_currency

    # No conversion needed if same currency
    return Money.new(avg_monthly_cost, target) if source == target

    # Use Money's exchange_to with fallback rate
    Money.new(avg_monthly_cost, source).exchange_to(target, fallback_rate: 1.0)
  rescue Money::ConversionError
    # Fallback: display in source currency if conversion fails
    Money.new(avg_monthly_cost, source)
  end

  # Formatted avg_monthly_cost in user's currency
  def formatted_avg_monthly_cost(target_currency = nil)
    money = avg_monthly_cost_in(target_currency)
    money&.format || nil
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
        { name: "HelloFresh", subscription_category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 60.00, popular: true },

        # Utilities & Bills (Templates - no specific cost as it varies)
        { name: "Rent/Mortgage", subscription_category: "housing", billing_frequency: "monthly", popular: true },
        { name: "Electricity", subscription_category: "energy", billing_frequency: "monthly", popular: true },
        { name: "Gas", subscription_category: "energy", billing_frequency: "monthly", popular: true },
        { name: "Water", subscription_category: "water", billing_frequency: "monthly", popular: true },
        { name: "Internet", subscription_category: "internet", billing_frequency: "monthly", popular: true },
        { name: "Mobile Phone", subscription_category: "mobile_phone", billing_frequency: "monthly", popular: true },
        { name: "Home Insurance", subscription_category: "insurance", billing_frequency: "monthly", popular: true },
        { name: "Car Insurance", subscription_category: "insurance", billing_frequency: "monthly", popular: true },
        { name: "Gym Membership", subscription_category: "gym", billing_frequency: "monthly", popular: true },

        # Indonesian Utilities (common providers)
        { name: "PLN (Listrik)", subscription_category: "energy", billing_frequency: "monthly", popular: true },
        { name: "PDAM (Air)", subscription_category: "water", billing_frequency: "monthly", popular: true },
        { name: "IndiHome", subscription_category: "internet", billing_frequency: "monthly", avg_monthly_cost: 50.00, popular: true },
        { name: "Biznet", subscription_category: "internet", billing_frequency: "monthly", avg_monthly_cost: 40.00, popular: true },
        { name: "MyRepublic", subscription_category: "internet", billing_frequency: "monthly", avg_monthly_cost: 35.00, popular: true },
        { name: "Telkomsel (Postpaid)", subscription_category: "mobile_phone", billing_frequency: "monthly", popular: true },
        { name: "XL (Postpaid)", subscription_category: "mobile_phone", billing_frequency: "monthly", popular: true },
        { name: "Indosat (Postpaid)", subscription_category: "mobile_phone", billing_frequency: "monthly", popular: true },
        { name: "PGN (Gas)", subscription_category: "energy", billing_frequency: "monthly", popular: true }
      ]
    end
end
