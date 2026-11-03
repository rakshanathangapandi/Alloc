from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # PostgreSQL connection string shared with the backend (same DB, separate schema)
    database_url: str

    # Optional — override the backend base URL for internal calls (not used yet, reserved)
    backend_url: str = "http://localhost:3000"

    # HTTP port for the agent service
    port: int = 8000


settings = Settings()
