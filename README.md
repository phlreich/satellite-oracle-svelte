The skies are busy, we prosper.
## Getting Started

### Prerequisites
- A free account at [space-track.org](https://www.space-track.org/auth/login)
- OpenAI API Key

### Setup Instructions

1. Clone the repository

2. Create a `.env` file by copying the example:
   ```bash
   cp .env.example .env
   ```

3. Fill in your credentials in the `.env` file:
   - EMAIL: Your space-track.org account email
   - PASSWORD: Your space-track.org password
   - OPENAI_API_KEY: Your OpenAI API key

4. Start the application:
   ```bash
   npm i
   npm run dev
   ```

The application should now be running and accessible through your web browser.

## Application Overview

Once the application is running, you will see a visualization of the Earth with human-made objects orbiting it in real time. This provides a dynamic view of satellites and other objects in space.

## Using the Chat Interface

The application includes a chat interface that allows you to filter and interact with the objects in orbit. You can use natural language queries to filter the objects based on various criteria. For example, you can type:

- "Show me all objects launched by NASA in 2020"

This will filter the displayed objects to only those that match your query, providing a powerful tool for exploring the data.

//TODO
- correct the relative positions
- add the moon
- implement orbit ellipses
- implement highlighting, filtering, information display
- improve performance
- test on safari