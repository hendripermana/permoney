class ServicesController < ApplicationController
  before_action :authenticate_user!
  before_action :set_service, only: %i[edit update destroy]

  layout :determine_layout

  def index
    @services = ServiceMerchant.order(:subscription_category, :name)
    @popular_services = ServiceMerchant.popular.order(:name)
    @custom_services = ServiceMerchant.where(popular: false).order(:name)
  end

  def new
    @service = ServiceMerchant.new
    @categories = ServiceMerchant::CATEGORIES
  end

  def create
    @service = ServiceMerchant.new(service_params)

    respond_to do |format|
      if @service.save
        flash[:notice] = "Service created successfully!"
        format.html { redirect_to services_path, notice: "Service created successfully!" }
        format.turbo_stream { render turbo_stream: turbo_stream.action(:redirect, services_path) }
      else
        @categories = ServiceMerchant::CATEGORIES
        format.html { render :new, status: :unprocessable_entity }
        format.turbo_stream { render :new, status: :unprocessable_entity }
      end
    end
  end

  def edit
    @categories = ServiceMerchant::CATEGORIES
  end

  def update
    respond_to do |format|
      if @service.update(service_params)
        flash[:notice] = "Service updated successfully!"
        format.html { redirect_to services_path, notice: "Service updated successfully!" }
        format.turbo_stream { render turbo_stream: turbo_stream.action(:redirect, services_path) }
      else
        @categories = ServiceMerchant::CATEGORIES
        format.html { render :edit, status: :unprocessable_entity }
        format.turbo_stream { render :edit, status: :unprocessable_entity }
      end
    end
  end

  def destroy
    if @service.subscription_plans.any?
      redirect_to services_path, alert: "Cannot delete service with active subscriptions."
    else
      @service.destroy
      redirect_to services_path, notice: "Service deleted successfully!"
    end
  end

  def seed_popular
    ServiceMerchant.seed_popular_services
    redirect_to services_path, notice: "Popular services have been added!"
  end

  private

    def determine_layout
      if turbo_frame_request?
        false
      else
        "settings"
      end
    end

    def set_service
      @service = ServiceMerchant.find(params[:id])
    end

    def service_params
      params.require(:service_merchant).permit(
        :name, :subscription_category, :billing_frequency,
        :avg_monthly_cost, :description, :website_url
      )
    end
end
