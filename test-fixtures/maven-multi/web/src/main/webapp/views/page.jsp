<%@ page contentType="text/html;charset=UTF-8" %>
<%@ page import="com.acme.core.UserService, org.apache.commons.lang3.StringUtils" %>
<%@ page import="org.apache.commons.io.FileUtils, java.util.*" %>
<%
    UserService svc = new UserService();
    String name = svc.findName(1);
    boolean blank = StringUtils.isBlank(name);
    String sid = request.getSession().getId();
    List<String> xs = new ArrayList<>();
    xs.get(0).trim();
    FileUtils.getTempDirectory();
%>
