# frozen_string_literal: true

class Session < ApplicationRecord
  belongs_to :player

  validates :token, presence: true, uniqueness: true
  validates :expires_at, presence: true

  scope :live, -> { where(expires_at: Time.current..) }

  # Named `active?`, not `valid?`: ActiveRecord::Model#valid? takes a context
  # argument and overloading it breaks `save`.
  def active?(now = Time.current)
    expires_at.present? && expires_at > now
  end

  def expire!
    now = Time.current
    update_columns(expires_at: now, updated_at: now) unless expires_at <= now
    self
  end
end
