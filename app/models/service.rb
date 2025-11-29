class Service < ApplicationRecord
  has_many :subscription_plans, dependent: :destroy
  has_many :families, through: :subscription_plans

  # Service categories based on financial best practices
  enum :category, {
    streaming: "streaming",        # Netflix, Spotify, Disney+
    software: "software",          # Adobe, Microsoft 365, SaaS tools
    utilities: "utilities",        # Electricity, water, internet
    subscriptions: "subscriptions", # Magazines, boxes, memberships
    memberships: "memberships",    # Gym, clubs, organizations
    insurance: "insurance",        # Health, car, home insurance
    telecommunications: "telecommunications", # Phone, cable TV
    cloud_services: "cloud_services", # AWS, Google Cloud, hosting
    education: "education",        # Online courses, tutoring
    entertainment: "entertainment", # Gaming, sports, events
    health_wellness: "health_wellness", # Supplements, fitness apps
    finance: "finance",           # Banking fees, investment platforms
    transportation: "transportation", # Ride-sharing, public transit apps
    food_delivery: "food_delivery", # Meal kits, delivery services
    other: "other"                # Uncategorized services
  }, prefix: true

  # Billing frequency options
  enum :billing_frequency, {
    monthly: "monthly",
    annual: "annual",
    quarterly: "quarterly",
    biennial: "biennial",
    one_time: "one_time"
  }, prefix: true

  # Validations
  validates :name, presence: true, uniqueness: true
  validates :category, presence: true, inclusion: { in: categories.keys }
  validates :billing_frequency, presence: true, inclusion: { in: billing_frequencies.keys }
  validates :avg_monthly_cost, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true

  # Scopes for business logic
  scope :auto_detected, -> { where(auto_detected: true) }
  scope :popular, -> { where(popular: true) }
  scope :by_category, ->(category) { where(category: category) }
  scope :streaming_services, -> { where(category: "streaming") }
  scope :software_solutions, -> { where(category: "software") }
  scope :utilities, -> { where(category: "utilities") }

  # Class methods for popular services seeding
  def self.seed_popular_services
    popular_services = [
      # Streaming Services
      { name: "Netflix", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 15.99, popular: true },
      { name: "Spotify Premium", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 9.99, popular: true },
      { name: "Disney+", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 7.99, popular: true },
      { name: "Amazon Prime Video", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 8.99, popular: true },
      { name: "Hulu", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 7.99, popular: true },
      { name: "Apple TV+", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 4.99, popular: true },
      { name: "YouTube Premium", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 11.99, popular: true },
      { name: "Paramount+", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 5.99, popular: true },
      { name: "HBO Max", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 15.99, popular: true },
      { name: "Apple Music", category: "streaming", billing_frequency: "monthly", avg_monthly_cost: 10.99, popular: true },

      # Software & SaaS
      { name: "Adobe Creative Cloud", category: "software", billing_frequency: "monthly", avg_monthly_cost: 52.99, popular: true },
      { name: "Microsoft 365", category: "software", billing_frequency: "monthly", avg_monthly_cost: 6.99, popular: true },
      { name: "Google Workspace", category: "software", billing_frequency: "monthly", avg_monthly_cost: 6.00, popular: true },
      { name: "Dropbox", category: "software", billing_frequency: "monthly", avg_monthly_cost: 10.00, popular: true },
      { name: "Zoom", category: "software", billing_frequency: "monthly", avg_monthly_cost: 14.99, popular: true },
      { name: "Canva Pro", category: "software", billing_frequency: "monthly", avg_monthly_cost: 12.99, popular: true },
      { name: "Notion", category: "software", billing_frequency: "monthly", avg_monthly_cost: 8.00, popular: true },
      { name: "Slack", category: "software", billing_frequency: "monthly", avg_monthly_cost: 7.25, popular: true },
      { name: "Trello", category: "software", billing_frequency: "monthly", avg_monthly_cost: 12.50, popular: true },
      { name: "Figma", category: "software", billing_frequency: "monthly", avg_monthly_cost: 15.00, popular: true },

      # Utilities
      { name: "Netflix", category: "utilities", billing_frequency: "monthly", avg_monthly_cost: 85.00, popular: true },
      { name: "Electricity", category: "utilities", billing_frequency: "monthly", avg_monthly_cost: 150.00, popular: true },
      { name: "Internet", category: "utilities", billing_frequency: "monthly", avg_monthly_cost: 65.00, popular: true },
      { name: "Water", category: "utilities", billing_frequency: "monthly", avg_monthly_cost: 50.00, popular: true },
      { name: "Gas", category: "utilities", billing_frequency: "monthly", avg_monthly_cost: 75.00, popular: true },

      # Memberships
      { name: "Gym Membership", category: "memberships", billing_frequency: "monthly", avg_monthly_cost: 45.00, popular: true },
      { name: "Amazon Prime", category: "memberships", billing_frequency: "annual", avg_monthly_cost: 14.99, popular: true },
      { name: "Costco", category: "memberships", billing_frequency: "annual", avg_monthly_cost: 6.00, popular: true },
      { name: "Sam's Club", category: "memberships", billing_frequency: "annual", avg_monthly_cost: 5.00, popular: true },

      # Insurance
      { name: "Health Insurance", category: "insurance", billing_frequency: "monthly", avg_monthly_cost: 400.00, popular: true },
      { name: "Car Insurance", category: "insurance", billing_frequency: "monthly", avg_monthly_cost: 150.00, popular: true },
      { name: "Home Insurance", category: "insurance", billing_frequency: "monthly", avg_monthly_cost: 100.00, popular: true },
      { name: "Life Insurance", category: "insurance", billing_frequency: "monthly", avg_monthly_cost: 50.00, popular: true },

      # Telecommunications
      { name: "Mobile Phone", category: "telecommunications", billing_frequency: "monthly", avg_monthly_cost: 85.00, popular: true },
      { name: "Cable TV", category: "telecommunications", billing_frequency: "monthly", avg_monthly_cost: 100.00, popular: true },
      { name: "Home Phone", category: "telecommunications", billing_frequency: "monthly", avg_monthly_cost: 30.00, popular: true },

      # Cloud Services
      { name: "AWS", category: "cloud_services", billing_frequency: "monthly", avg_monthly_cost: 50.00, popular: true },
      { name: "Google Cloud", category: "cloud_services", billing_frequency: "monthly", avg_monthly_cost: 40.00, popular: true },
      { name: "Microsoft Azure", category: "cloud_services", billing_frequency: "monthly", avg_monthly_cost: 45.00, popular: true },
      { name: "DigitalOcean", category: "cloud_services", billing_frequency: "monthly", avg_monthly_cost: 20.00, popular: true },

      # Education
      { name: "Coursera", category: "education", billing_frequency: "monthly", avg_monthly_cost: 59.00, popular: true },
      { name: "Udemy", category: "education", billing_frequency: "one_time", avg_monthly_cost: 20.00, popular: true },
      { name: "MasterClass", category: "education", billing_frequency: "annual", avg_monthly_cost: 15.00, popular: true },
      { name: "LinkedIn Learning", category: "education", billing_frequency: "monthly", avg_monthly_cost: 29.99, popular: true },

      # Health & Wellness
      { name: "MyFitnessPal Premium", category: "health_wellness", billing_frequency: "monthly", avg_monthly_cost: 19.99, popular: true },
      { name: "Headspace", category: "health_wellness", billing_frequency: "monthly", avg_monthly_cost: 12.99, popular: true },
      { name: "Calm", category: "health_wellness", billing_frequency: "monthly", avg_monthly_cost: 14.99, popular: true },
      { name: "BetterHelp", category: "health_wellness", billing_frequency: "monthly", avg_monthly_cost: 80.00, popular: true },

      # Finance
      { name: "Mint", category: "finance", billing_frequency: "monthly", avg_monthly_cost: 0.00, popular: true },
      { name: "Personal Capital", category: "finance", billing_frequency: "monthly", avg_monthly_cost: 0.00, popular: true },
      { name: "QuickBooks", category: "finance", billing_frequency: "monthly", avg_monthly_cost: 15.00, popular: true },
      { name: "TurboTax", category: "finance", billing_frequency: "one_time", avg_monthly_cost: 50.00, popular: true },

      # Transportation
      { name: "Uber", category: "transportation", billing_frequency: "monthly", avg_monthly_cost: 60.00, popular: true },
      { name: "Lyft", category: "transportation", billing_frequency: "monthly", avg_monthly_cost: 55.00, popular: true },
      { name: "Tesla Charging", category: "transportation", billing_frequency: "monthly", avg_monthly_cost: 25.00, popular: true },
      { name: "Public Transit App", category: "transportation", billing_frequency: "monthly", avg_monthly_cost: 35.00, popular: true },

      # Food Delivery
      { name: "DoorDash", category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 15.00, popular: true },
      { name: "Uber Eats", category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 12.00, popular: true },
      { name: "Grubhub", category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 14.00, popular: true },
      { name: "HelloFresh", category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 60.00, popular: true },
      { name: "Blue Apron", category: "food_delivery", billing_frequency: "monthly", avg_monthly_cost: 72.00, popular: true }
    ]

    popular_services.each do |service_data|
      service = find_or_initialize_by(name: service_data[:name])
      service.assign_attributes(service_data)
      service.save! if service.changed?
    end
  end

  # Instance methods
  def display_name
    name
  end

  def formatted_avg_cost
    avg_monthly_cost&.present? ? "$#{avg_monthly_cost}" : "N/A"
  end

  def monthly_equivalent_cost
    case billing_frequency
    when "annual"
      avg_monthly_cost / 12.0 if avg_monthly_cost.present?
    when "quarterly"
      avg_monthly_cost / 3.0 if avg_monthly_cost.present?
    when "biennial"
      avg_monthly_cost / 24.0 if avg_monthly_cost.present?
    else
      avg_monthly_cost
    end
  end

  def category_icon
    case category
    when "streaming"
      "📺"
    when "software"
      "💻"
    when "utilities"
      "⚡"
    when "subscriptions"
      "📦"
    when "memberships"
      "🤝"
    when "insurance"
      "🛡️"
    when "telecommunications"
      "📡"
    when "cloud_services"
      "☁️"
    when "education"
      "📚"
    when "entertainment"
      "🎮"
    when "health_wellness"
      "🧘"
    when "finance"
      "💰"
    when "transportation"
      "🚗"
    when "food_delivery"
      "🍔"
    else
      "📋"
    end
  end

  def to_s
    name
  end
end
