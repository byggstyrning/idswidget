# IDS Widget for StreamBIM

This project contains an IDS (Information Delivery Specification) widget for StreamBIM, built using FastHTML.

## Project Overview

The IDS Widget is a FastHTML application that provides functionality for validating IFC files against IDS specifications. It integrates with StreamBIM and uses the ifctester service for validation.

## Key Components

1. `idswidget/idswidget.py`: Main FastHTML application file
2. `ifctester/ifctester-service.py`: FastAPI service for IFC validation (based on [ifcpipeline](https://github.com/jonatanjacobsson/ifcpipeline))
3. `idswidget/js/ids-widget.js`: Client-side JavaScript for widget functionality
4. `shared/classes.py`: Shared data models
5. Docker configuration for both the widget and ifctester service

## Features

- IFC file selection from uploaded StreamBIM documents and validation against IDS specifications
- JSON and HTML report generation
- Integration with StreamBIM for 3D model visualization
- Highlighting of failed entities in the 3D model
- Copying element IDs for use in Revit

## Integration with StreamBIM

This IDS Widget is designed to be integrated into your StreamBIM projects.

For more detailed information on how to use the StreamBIM Widget API, please refer to the [official documentation](https://github.com/streambim/streambim-widget-api).


### Running the Application

1. Clone this repository:
   ```
   git clone https://github.com/byggstyrning/idswidget.git
   cd idswidget
   ```

2. Build and run the Docker containers:
   ```
   docker-compose up --build
   ```

3. Access the IDS widget at `http://localhost:3000`.

4. Host the widget on a publicly accessible url, either self-hosted or on a public cloud service.

5. Contact StreamBIM support (support@rendra.io) to whitelist the widget in your project and let them know the widget URL and what you want to call the widget.

6. Once approved, you'll see the widget in the StreamBIM interface, allowing users to select IFC files and perform IDS validations directly within the StreamBIM environment.

## Project Structure

- `idswidget/`: Contains the main FastHTML application
- `ifctester/`: Contains the IDS validation service
- `shared/`: Contains shared uploads

## FastHTML Integration

This project uses FastHTML for rapid development and efficient rendering. The main entry point is `idswidget/idswidget.py`.

## Contributing

We welcome contributions to the IDS Widget project! Feel free to fork the repository, make your changes, and open a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.

## IFC Validation

The IFC validation functionality in this project is based on the [ifcpipeline](https://github.com/jonatanjacobsson/ifcpipeline). The ifctester service in our project utilizes components from ifcopenshell to perform IFC file validation against IDS specifications.

For more information about the underlying IFC processing capabilities, please refer to the [ifcpipeline repository](https://github.com/jonatanjacobsson/ifcpipeline) and the [ifcopenshell project](https://github.com/IfcOpenShell/IfcOpenShell).


## StreamBIM Widget API Integration

The StreamBIM Widget API (`streambim-widget-api.min.js`) is automatically downloaded during the Docker build process and placed in the `/js/` directory. This ensures that the widget has access to the necessary StreamBIM integration functions without manual intervention.

