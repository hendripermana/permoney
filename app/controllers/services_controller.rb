class ServicesController < ApplicationController
  before_action :authenticate_user!
  before_action :set_service, only: %i[edit update destroy]

  layout :determine_layout

  def index
    @services = Service.order(:category, :name)
    @popular_services = Service.popular.order(:name)
    @custom_services = Service.where(popular: false).order(:name)
  end

  def new
    @service = Service.new
    @categories = Service.categories.keys
  end

  def create
    @service = Service.new(service_params)

    respond_to do |format|
      if @service.save
        format.html { redirect_to services_path, notice: "Service created successfully!" }
        format.turbo_stream { redirect_to services_path, notice: "Service created successfully!" }
      else
        @categories = Service.categories.keys
        format.html { render :new, status: :unprocessable_entity }
        format.turbo_stream { render :new, status: :unprocessable_entity }
      end
    end
  end

  def edit
    @categories = Service.categories.keys
  end

  def update
    respond_to do |format|
      if @service.update(service_params)
        format.html { redirect_to services_path, notice: "Service updated successfully!" }
        format.turbo_stream { redirect_to services_path, notice: "Service updated successfully!" }
      else
        @categories = Service.categories.keys
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
    Service.seed_popular_services
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
      @service = Service.find(params[:id])
    end

    def service_params
      params.require(:service).permit(
        :name, :category, :billing_frequency,
        :avg_monthly_cost, :description, :website_url
      )
    end
end
