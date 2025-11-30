class SubscriptionPlansController < ApplicationController
  before_action :authenticate_user!
  before_action :set_subscription_plan, only: %i[show edit update destroy pause resume cancel renew]
  before_action :authorize_family_access, only: %i[show edit update destroy pause resume cancel renew]

  # GET /subscription_plans
  def index
    @subscription_plans = Current.family.subscription_plans
      .includes(:service, :merchant, :account)
      .unarchived
      .order(:name)

    # Dashboard data
    @active_subscriptions = @subscription_plans.active
    @upcoming_renewals = @subscription_plans.upcoming_renewals
    @overdue_subscriptions = @subscription_plans.overdue
    @trial_ending = @subscription_plans.trial_ending

    # Analytics
    @analytics = SubscriptionAnalytics.new(Current.family)

    respond_to do |format|
      format.html
      format.json { render json: safe_subscription_json(@subscription_plans) }
    end
  end

  # GET /subscription_plans/1
  def show
    respond_to do |format|
      format.html
      format.json { render json: safe_subscription_json(@subscription_plan) }
    end
  end

  # GET /subscription_plans/new
  def new
    @subscription_plan = Current.family.subscription_plans.new(
      currency: Current.family.currency,
      started_at: Date.current,
      next_billing_at: 1.month.from_now.to_date
    )
    @services = load_services
    @accounts = Current.family.accounts

    respond_to do |format|
      format.html
      format.json { render json: safe_subscription_json(@subscription_plan) }
    end
  end

  # POST /subscription_plans
  def create
    @subscription_plan = Current.family.subscription_plans.new(subscription_plan_params)

    respond_to do |format|
      if @subscription_plan.save
        track_subscription_created(@subscription_plan)
        format.html {
          redirect_to subscription_plans_path,
          notice: "Subscription plan created successfully!"
        }
        format.json { render json: safe_subscription_json(@subscription_plan), status: :created }
      else
        @services = load_services
        @accounts = Current.family.accounts
        format.html { render :new, status: :unprocessable_entity }
        format.json { render json: @subscription_plan.errors, status: :unprocessable_entity }
      end
    end
  end

  # GET /subscription_plans/1/edit
  def edit
    @services = load_services
    @accounts = Current.family.accounts

    respond_to do |format|
      format.html
      format.json { render json: safe_subscription_json(@subscription_plan) }
    end
  end

  # PATCH/PUT /subscription_plans/1
  def update
    respond_to do |format|
      if @subscription_plan.update(subscription_plan_params)
        format.html {
          redirect_to subscription_plans_path,
          notice: "Subscription plan updated successfully!"
        }
        format.json { render json: safe_subscription_json(@subscription_plan) }
      else
        @services = Service.all.order(:name)
        @accounts = Current.family.accounts
        format.html { render :edit, status: :unprocessable_entity }
        format.json { render json: @subscription_plan.errors, status: :unprocessable_entity }
      end
    end
  end

  # DELETE /subscription_plans/1
  def destroy
    @subscription_plan.archive!

    respond_to do |format|
      format.html {
        redirect_to subscription_plans_path,
        notice: "Subscription plan archived successfully!"
      }
      format.json { head :no_content }
    end
  end

  # PATCH /subscription_plans/1/pause
  def pause
    @subscription_plan.pause!

    respond_to do |format|
      format.html {
        redirect_to subscription_plans_path,
        notice: "Subscription plan paused!"
      }
      format.json { render json: safe_subscription_json(@subscription_plan) }
    end
  end

  # PATCH /subscription_plans/1/resume
  def resume
    @subscription_plan.resume!

    respond_to do |format|
      format.html {
        redirect_to subscription_plans_path,
        notice: "Subscription plan resumed!"
      }
      format.json { render json: safe_subscription_json(@subscription_plan) }
    end
  end

  # PATCH /subscription_plans/1/cancel
  def cancel
    @subscription_plan.cancel!

    respond_to do |format|
      format.html {
        redirect_to subscription_plans_path,
        notice: "Subscription plan cancelled!"
      }
      format.json { render json: safe_subscription_json(@subscription_plan) }
    end
  end

  # PATCH /subscription_plans/1/renew
  def renew
    @subscription_plan.mark_as_renewed!

    respond_to do |format|
      format.html {
        redirect_to subscription_plans_path,
        notice: "Subscription plan renewed!"
      }
      format.json { render json: safe_subscription_json(@subscription_plan) }
    end
  end

  private

    def set_subscription_plan
      @subscription_plan = Current.family.subscription_plans.find(params[:id])
    end

    def authorize_family_access
      return if @subscription_plan.family == Current.family
      redirect_to root_path, alert: "Access denied"
    end

    def subscription_plan_params
      params.require(:subscription_plan).permit(
        :name, :description, :service_id, :merchant_id, :account_id,
        :amount, :currency, :billing_cycle, :status,
        :started_at, :trial_ends_at, :next_billing_at,
        :auto_renew, :payment_method, :shared_within_family,
        :max_usage_allowed, :payment_notes
      )
    end

    # Sanitize subscription data for JSON responses to prevent data exposure
    def safe_subscription_json(subscriptions)
      safe_attributes = %i[
        id name description amount currency billing_cycle status
        started_at trial_ends_at next_billing_at auto_renew
        payment_method shared_within_family created_at updated_at
      ]

      if subscriptions.respond_to?(:map)
        subscriptions.map { |sub| subscription_to_safe_hash(sub, safe_attributes) }
      else
        subscription_to_safe_hash(subscriptions, safe_attributes)
      end
    end

    def subscription_to_safe_hash(subscription, safe_attributes)
      sm = subscription.service_merchant
      hash = subscription.as_json(only: safe_attributes)
      hash["service_name"] = sm&.name
      hash["service_category"] = sm.respond_to?(:subscription_category) ? sm.subscription_category : sm&.category
      hash["account_name"] = subscription.account&.name
      hash["days_until_renewal"] = subscription.days_until_renewal
      hash["monthly_equivalent_amount"] = subscription.monthly_equivalent_amount
      hash
    end

    # Load services from both ServiceMerchant and legacy Service tables
    def load_services
      # Prefer ServiceMerchant, fallback to Service for backward compatibility
      service_merchants = ServiceMerchant.popular.order(:name)

      if service_merchants.any?
        service_merchants
      elsif defined?(Service) && Service.table_exists?
        Service.popular.order(:name)
      else
        []
      end
    end

    def track_subscription_created(subscription_plan)
      sm = subscription_plan.service_merchant

      # Analytics tracking
      if defined?(Ahoy)
        ahoy.track(
          "subscription_created",
          {
            subscription_id: subscription_plan.id,
            service: sm&.name,
            amount: subscription_plan.amount,
            billing_cycle: subscription_plan.billing_cycle,
            payment_method: subscription_plan.payment_method
          }
        )
      end

      # Sentry tracking for monitoring
      Sentry.capture_message(
        "Subscription created",
        level: :info,
        tags: {
          service: sm&.name,
          billing_cycle: subscription_plan.billing_cycle
        },
        extra: {
          family_id: Current.family.id,
          user_id: Current.user.id,
          amount: subscription_plan.amount
        }
      )
    end
end
